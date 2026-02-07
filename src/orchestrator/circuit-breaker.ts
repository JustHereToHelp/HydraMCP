/**
 * Circuit breaker — per-model failure tracking with automatic recovery.
 *
 * States:
 *   closed    → normal operation, requests flow through
 *   open      → model disabled after N consecutive failures, requests rejected
 *   half-open → cooldown expired, allow one retry to test recovery
 *
 * On success → reset to closed.
 * On failure in half-open → back to open with fresh cooldown.
 */

import { logger } from "../utils/logger.js";

export type CircuitState = "closed" | "open" | "half-open";

interface ModelCircuit {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
}

export interface CircuitBreakerConfig {
  maxFailures: number;
  cooldownMs: number;
}

export class CircuitBreaker {
  private circuits: Map<string, ModelCircuit> = new Map();
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  /** Check if the circuit is open (model should not be called). */
  isOpen(model: string): boolean {
    const circuit = this.circuits.get(model);
    if (!circuit || circuit.state === "closed") return false;

    if (circuit.state === "open") {
      // Check if cooldown has expired → transition to half-open
      if (Date.now() - circuit.lastFailureTime >= this.config.cooldownMs) {
        circuit.state = "half-open";
        logger.info(
          `circuit-breaker: ${model} → half-open (cooldown expired, allowing retry)`
        );
        return false; // Allow one retry
      }
      return true; // Still in cooldown
    }

    // half-open: allow the retry
    return false;
  }

  /** Record a successful query — reset circuit to closed. */
  recordSuccess(model: string): void {
    const circuit = this.circuits.get(model);
    if (!circuit) return;

    if (circuit.state !== "closed") {
      logger.info(`circuit-breaker: ${model} → closed (recovered)`);
    }
    this.circuits.delete(model); // Clean state = no entry
  }

  /** Record a failed query — increment failures, potentially open circuit. */
  recordFailure(model: string): void {
    const circuit = this.circuits.get(model) ?? {
      state: "closed" as CircuitState,
      failures: 0,
      lastFailureTime: 0,
    };

    circuit.failures++;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === "half-open") {
      // Retry failed — back to open
      circuit.state = "open";
      logger.warn(
        `circuit-breaker: ${model} → open (retry failed, ${circuit.failures} total failures)`
      );
    } else if (circuit.failures >= this.config.maxFailures) {
      circuit.state = "open";
      logger.warn(
        `circuit-breaker: ${model} → open (${circuit.failures} consecutive failures)`
      );
    }

    this.circuits.set(model, circuit);
  }

  /** Get status of all tracked models. */
  getStatus(): Map<string, { state: CircuitState; failures: number }> {
    const status = new Map<string, { state: CircuitState; failures: number }>();
    for (const [model, circuit] of this.circuits) {
      status.set(model, {
        state: circuit.state,
        failures: circuit.failures,
      });
    }
    return status;
  }

  /** Get list of models currently in open state. */
  getOpenModels(): string[] {
    const open: string[] = [];
    for (const [model, circuit] of this.circuits) {
      if (circuit.state === "open") {
        // Check if still within cooldown
        if (Date.now() - circuit.lastFailureTime < this.config.cooldownMs) {
          open.push(model);
        }
      }
    }
    return open;
  }
}
