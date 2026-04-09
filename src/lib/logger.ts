/**
 * Logger for Profanity Filter extension.
 *
 * In dev builds (__DEV__ = true), log() and debug() emit to console.
 * In prod builds (__DEV__ = false), those calls are dead-code eliminated.
 * warn() and error() always emit regardless of build mode.
 */

// __DEV__ is injected at build time via esbuild --define
declare const __DEV__: boolean;

const PREFIX = "[FFProfanity]";

export function log(...args: unknown[]): void {
  if (__DEV__) {
    console.log(PREFIX, ...args);
  }
}

export function debug(...args: unknown[]): void {
  if (__DEV__) {
    console.debug(PREFIX, ...args);
  }
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}