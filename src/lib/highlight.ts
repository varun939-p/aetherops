import { lexLines, type Segment } from "./lexer";

/** Token-level syntax classes layered on top of the lexer's code/string/comment segmentation. */

export type TokenClass = "kw" | "str" | "com" | "num" | "fn" | "";

export interface Token {
  cls: TokenClass;
  text: string;
}

const KEYWORDS: Record<string, string> = {
  js: "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield type interface enum implements private protected public readonly as satisfies keyof declare namespace abstract",
  python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self cls",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  c: "auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace public private protected virtual template typename new delete this true false nullptr using bool",
  java: "abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws transient true false try void volatile while var record",
  sql: "select from where and or not insert into values update set delete create table index drop alter join left right inner outer on group by order having limit offset as distinct null is in exists case when then else end primary key foreign references with returning union all",
  shell: "if then else elif fi for while do done case esac in function return export local readonly",
};

const FAMILY_BY_LANGUAGE: Record<string, string> = {
  javascript: "js", typescript: "js", vue: "js", svelte: "js",
  python: "python", go: "go", rust: "rust",
  c: "c", cpp: "c", csharp: "java", java: "java", kotlin: "java", scala: "java", swift: "java", dart: "java", php: "java",
  sql: "sql", shell: "shell", dockerfile: "shell", makefile: "shell",
};

const keywordCache = new Map<string, Set<string>>();

function keywordsFor(language: string): Set<string> {
  const family = FAMILY_BY_LANGUAGE[language];
  if (!family) return new Set();
  let set = keywordCache.get(family);
  if (!set) {
    set = new Set(KEYWORDS[family].split(" "));
    keywordCache.set(family, set);
  }
  return set;
}

function tokenizeCode(text: string, keywords: Set<string>, caseInsensitive: boolean): Token[] {
  const out: Token[] = [];
  const re = /([A-Za-z_$][\w$]*)(\s*\()?|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ cls: "", text: text.slice(last, m.index) });
    if (m[3]) out.push({ cls: "num", text: m[3] });
    else {
      const word = m[1];
      const isKw = keywords.has(caseInsensitive ? word.toLowerCase() : word);
      out.push({ cls: isKw ? "kw" : m[2] ? "fn" : "", text: word });
      if (m[2]) out.push({ cls: "", text: m[2] });
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ cls: "", text: text.slice(last) });
  return out;
}

export function highlightLines(lines: string[], language: string): Token[][] {
  const keywords = keywordsFor(language);
  const ci = language === "sql";
  return lexLines(lines, language).map((segments: Segment[]) =>
    segments.flatMap((s): Token[] =>
      s.kind === "string" ? [{ cls: "str", text: s.text }] : s.kind === "comment" ? [{ cls: "com", text: s.text }] : tokenizeCode(s.text, keywords, ci)
    )
  );
}
