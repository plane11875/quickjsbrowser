/* tslint:disable */
/* eslint-disable */
export function add_resource(url: string, bytes: Uint8Array): string;
export function clear_resources(): void;
export function missed_resources(): Array<any>;
export function add_font(bytes: Uint8Array, family: string): number;
export function set_generic_lead(generic: string, families: Array<any>): boolean;
export function render_png_rgba_no_js(html: string, base_url: string, width: number, height: number): Uint8Array;
export function last_panic(): string;
export function initialize(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly add_font: (a: number, b: number, c: number, d: number) => number;
  readonly add_resource: (a: number, b: number, c: number, d: number) => [number, number];
  readonly clear_resources: () => void;
  readonly initialize: () => void;
  readonly last_panic: () => [number, number];
  readonly missed_resources: () => any;
  readonly render_png_rgba_no_js: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly set_generic_lead: (a: number, b: number, c: any) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
