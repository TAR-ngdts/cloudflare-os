/** No-op decorators: argument validation is exercised by the real runtime, not by these Node tests. */
export const validateRpc = () => (target: unknown) => target;
export const skipRpcValidation = () => (target: unknown) => target;
