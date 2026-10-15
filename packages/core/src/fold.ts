/** Case and diacritic folding used for filter matching (docs/architecture.md section 5, fold rule). */
export function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
