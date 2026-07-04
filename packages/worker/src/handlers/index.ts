export * from './registry.js';
export { sleepHandler } from './sleep.js';
export { httpFetchHandler } from './http_fetch.js';
export { alwaysFailHandler } from './always_fail.js';

import { HandlerRegistry } from './registry.js';
import { sleepHandler } from './sleep.js';
import { httpFetchHandler } from './http_fetch.js';
import { alwaysFailHandler } from './always_fail.js';

/** The default registry: the three reference handlers, nothing else. */
export function buildDefaultRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry();
  registry.register(sleepHandler);
  registry.register(httpFetchHandler);
  registry.register(alwaysFailHandler);
  return registry;
}
