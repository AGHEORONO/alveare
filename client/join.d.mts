// Types for the zero-dependency join client (client/join.mjs), so the CLI can import it statically.
export interface HookCommand { command: string; args: string[] }
export interface JoinConfig {
  server: string; name: string; token: string; mcp_url: string; hook_url: string;
  dashboard_url: string; repo_root: string; clients: string[];
}
export interface ClientDef { label: string; detect(): boolean; instructions: string[]; hooks?: boolean }
export const MCP_NAME: string;
export const CLIENTS: Record<string, ClientDef>;
export function join(o: {
  address: string; code: string; name?: string; cwd?: string; clients?: string[];
  skipInstructions?: boolean; hook?: HookCommand;
}): Promise<JoinConfig>;
export function rehost(address: string, cwd?: string, hook?: HookCommand): Promise<JoinConfig>;
export function repoRoot(cwd?: string): string | null;
export function defaultName(): string;
export function normalizeAddress(a: string): string;
export function detectClients(): string[];
export const CLIENT_ALIASES: Record<string, string>;
export function resolveClient(id: string): string;
