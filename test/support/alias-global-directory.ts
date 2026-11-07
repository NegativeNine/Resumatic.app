/** Route an isolated Directory fixture's control-plane callbacks to itself. */
export function aliasAsGlobal(instance: unknown, state: DurableObjectState): () => void {
  const local = (instance as { env: Env }).env, original = local.DIRECTORY;
  local.DIRECTORY = new Proxy(original, {
    get(target, property) {
      if (property === "idFromName") return (name: string) => name === "global" ? state.id : target.idFromName(name);
      if (property === "get") return (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
        id.equals(state.id) ? instance : target.get(id, options);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return () => { local.DIRECTORY = original; };
}
