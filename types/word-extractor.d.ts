declare module "word-extractor" {
  class WordDocument {
    getBody(): string;
    getHeaders(): string;
    getFooters(): string;
    getFootnotes(): string;
    getEndnotes(): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
}
