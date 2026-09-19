export interface ImageCandidate {
  url: string;
  width?: number;
  height?: number;
  source: string;
  score: number;
}

export interface ExtractedAsset {
  url: string;
  width?: number;
  height?: number;
  format?: string;
}

export interface ExtractResult {
  sourceUrl: string;
  images: ExtractedAsset[];
  logo: ExtractedAsset | null;
  warnings: string[];
}
