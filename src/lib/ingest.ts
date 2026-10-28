import { detectLanguage, extensionOf } from "./policy";
import { countLines, detectEol, sha256Hex, utf8ByteLength, type Eol } from "./text";

/** Canonical description of a source file, produced identically by the server walker and the browser fallback. */
export interface IngestedFile {
  path: string;
  content: string;
  hash: string;
  size: number;
  language: string;
  extension: string;
  eol: Eol;
  lineCount: number;
}

export async function describeFile(path: string, content: string): Promise<IngestedFile> {
  return {
    path,
    content,
    hash: await sha256Hex(content),
    size: utf8ByteLength(content),
    language: detectLanguage(path),
    extension: extensionOf(path).slice(0, 32),
    eol: detectEol(content),
    lineCount: countLines(content),
  };
}
