export function requiresEmbedResolution(source = {}) {
  const type = String(source.type || "").trim().toLowerCase();
  const externalType = String(source.externalType || "").trim().toLowerCase();

  if (type === "iframe") return true;
  if (["direct", "hls", "file", "video"].includes(type)) return false;
  return externalType === "iframe";
}

export function resolutionFailureStatus(result = {}) {
  return Number(result.media?.httpStatus ?? result.httpStatus ?? result.resolverStatus);
}
