/**
 * Response validation — catches empty or truncated model responses
 * before they reach the user.
 */

import { QueryResponse } from "../providers/provider.js";
import { logger } from "./logger.js";

export class EmptyResponseError extends Error {
  name = "EmptyResponseError" as const;
  constructor(model: string) {
    super(`Empty response from model: ${model}`);
  }
}

export function validateResponse(response: QueryResponse): QueryResponse {
  if (response.content.trim().length < 10 && !response.reasoning_content) {
    throw new EmptyResponseError(response.model);
  }

  if (response.finish_reason === "length") {
    (response as QueryResponse & { warning?: string }).warning = "truncated";
    logger.warn(
      `Response from ${response.model} was truncated (finish_reason=length)`
    );
  }

  return response;
}
