/**
 * Circuit breaker — fast-fail for models that are consistently broken.
 * Prevents wasting time/tokens on providers that are down.
 */
import { logger } from "./logger.js";

export class CircuitOpenError extends Error {
  name = "CircuitOpenError";
  constructor(model: string, cooldownRemaining: number) {
    super(`Circuit open for "${model}" — cooling down (${Math.ceil(cooldownRemaining / 1000)}s remaining)`);
  }
}

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitStats {
  state: CircuitState;
  failures: number;
  successes: number;
  totalRequests: number;
  lastFailure?: number;
}

interface CircuitData {
  state: CircuitState;
  results: boolean[]; // true=success, false=failure, sliding window
  openedAt: number;
}

export class CircuitBreaker {
  private windowSize: number;
  private failureThreshold: number; // open at this failure rate (0-1)
  private cooldownMs: number;

  private circuits: Map<string, CircuitData> = new Map();

  constructor(options?: { windowSize?: number; failureThreshold?: number; cooldownMs?: number }) {
    this.windowSize = options?.windowSize ?? 10;
    this.failureThreshold = options?.failureThreshold ?? 0.3;
    this.cooldownMs = options?.cooldownMs ?? 60_000;
  }

  private getCircuit(model: string): CircuitData {
    let circuit = this.circuits.get(model);
    if (!circuit) {
      circuit = { state: "CLOSED", results: [], openedAt: 0 };
      this.circuits.set(model, circuit);
    }
    return circuit;
  }

  async execute<T>(model: string, fn: () => Promise<T>): Promise<T> {
    const circuit = this.getCircuit(model);

    if (circuit.state === "OPEN") {
      const elapsed = Date.now() - circuit.openedAt;
      if (elapsed >= this.cooldownMs) {
        circuit.state = "HALF_OPEN";
        logger.info(`Circuit HALF_OPEN for "${model}" — allowing test request`);
      } else {
        throw new CircuitOpenError(model, this.cooldownMs - elapsed);
      }
    }

    try {
      const result = await fn();
      this.recordResult(model, true);

      if (circuit.state === "HALF_OPEN") {
        circuit.state = "CLOSED";
        logger.info(`Circuit CLOSED for "${model}" — recovered`);
      }

      return result;
    } catch (err) {
      this.recordResult(model, false);

      if (circuit.state === "HALF_OPEN") {
        circuit.state = "OPEN";
        circuit.openedAt = Date.now();
        logger.warn(`Circuit re-OPENED for "${model}" — test request failed`);
      } else if (circuit.state === "CLOSED") {
        this.checkThreshold(model);
      }

      throw err;
    }
  }

  private recordResult(model: string, success: boolean): void {
    const circuit = this.getCircuit(model);
    circuit.results.push(success);
    if (circuit.results.length > this.windowSize) {
      circuit.results = circuit.results.slice(-this.windowSize);
    }
  }

  private checkThreshold(model: string): void {
    const circuit = this.getCircuit(model);
    const minSamples = Math.ceil(this.windowSize / 2);
    if (circuit.results.length < minSamples) return;

    const failures = circuit.results.filter((r) => !r).length;
    const failureRate = failures / circuit.results.length;

    if (failureRate > this.failureThreshold) {
      circuit.state = "OPEN";
      circuit.openedAt = Date.now();
      logger.warn(
        `Circuit OPENED for "${model}" — failure rate ${(failureRate * 100).toFixed(0)}% exceeds ${(this.failureThreshold * 100).toFixed(0)}% threshold`
      );
    }
  }

  getStats(model: string): CircuitStats {
    const circuit = this.getCircuit(model);
    const failures = circuit.results.filter((r) => !r).length;
    const successes = circuit.results.filter((r) => r).length;
    const lastFailureIdx = circuit.results.lastIndexOf(false);
    return {
      state: circuit.state,
      failures,
      successes,
      totalRequests: circuit.results.length,
      lastFailure: lastFailureIdx >= 0 ? circuit.openedAt || undefined : undefined,
    };
  }

  getHealthSummary(): Record<string, CircuitStats> {
    const summary: Record<string, CircuitStats> = {};
    for (const model of this.circuits.keys()) {
      summary[model] = this.getStats(model);
    }
    return summary;
  }
}
