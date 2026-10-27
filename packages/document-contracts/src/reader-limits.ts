/** Absolute Reader/bundle v1 structural ceilings. Runtime configuration may tighten
 * these values, never raise them. Operational file byte budgets are separately configurable. */
export const readerContractCeilings = Object.freeze({
  maxFiles: 10000,
  maxPathBytes: 240,
  maxNodes: 100000,
  maxBlocks: 100000,
  maxDepth: 32,
  maxJsonDepth: 128,
  maxTextBytes: 524288,
  maxCodeBytes: 524288,
  maxLatexBytes: 16384,
  maxImagePixels: 40000000,
  maxImageDimension: 16384,
});
