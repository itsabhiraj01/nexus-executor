import { EXECUTOR_VERSION } from '../config.js';
import { GATEWAY_PROTOCOL_VERSION } from '../ops.js';

export function versionText(): string {
  return `nexus-executor v${EXECUTOR_VERSION}\nprotocol ${GATEWAY_PROTOCOL_VERSION}`;
}