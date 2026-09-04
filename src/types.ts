export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  message: string;
  skill?: string;
  file?: string;
  line?: number;
}

export interface Root {
  spec: string;
  path: string;
}

export interface Config {
  id: string | null;
  repoRoot: string;
  configPath: string | null;
  configText: string | null;
  sources: Root[];
  overrides: Root[];
  targets: Root[];
  sourcesIncomplete: boolean;
}

export type SlotMode = "replace" | "append";

/**
 * Where a line of the body came from. Splicing moves text between coordinate spaces, so a
 * diagnostic that carries a line number has to carry the file that number counts in as well.
 * `file: null` is the template's own body, numbered body-relative — the caller adds the
 * frontmatter offset, which it alone knows.
 */
export interface LineOrigin {
  file: string | null;
  line: number;
}

export interface SourceLine {
  text: string;
  /** Null for text the compiler inserted itself, which exists in no file. */
  origin: LineOrigin | null;
}

export interface SlotBlock {
  name: string;
  mode: SlotMode;
  /** The template's default text, each line still knowing the file and line it came from. */
  defaultBlock: SourceLine[];
  start: number;
  end: number;
}

/**
 * What a build decided for one slot. Recorded rather than discarded because `override` (phase 3)
 * must seed a file with the slot's current default and `explain` (phase 5) must say which
 * override is active and where it came from — both of which this is the only computation of.
 */
export interface SlotResolution {
  name: string;
  mode: SlotMode;
  /** The override root whose file filled the slot, or null where the template's default won. */
  from: Root | null;
  /**
   * The winning override file's own lines, before `append` composes them with the default — null
   * where no override root filled the slot. `override` seeds from this rather than from the
   * composed result, so a file it writes into a higher-precedence root reproduces exactly what the
   * slot resolves to today under either mode.
   */
  override: SourceLine[] | null;
}

export interface DiscoveredSkill {
  name: string;
  dir: string;
  sourceRoot: string;
  templatePath: string;
}

export interface ExtraFile {
  from: string;
  rel: string;
}

export interface CompiledSkill {
  name: string;
  content: string;
  extras: ExtraFile[];
}

/** Severity decides reject-vs-warn, so it is the constructor's to set and no caller's to pass. */
export type DiagnosticLocation = Omit<Diagnostic, "severity" | "message">;

export function error(message: string, extra: DiagnosticLocation = {}): Diagnostic {
  return { severity: "error", message, ...extra };
}

export function warning(message: string, extra: DiagnosticLocation = {}): Diagnostic {
  return { severity: "warning", message, ...extra };
}

/** Generic: what to put in a diagnostic for something thrown by a caller's `try`. */
export function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
