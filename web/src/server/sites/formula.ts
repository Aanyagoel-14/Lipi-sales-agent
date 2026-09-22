/**
 * The quote formula language.
 *
 * PRD §3.1 puts an expression in the request body:
 *
 *   BASE_VEHICLE_SIZE * COATING_GRADE + (PAINT_CORRECTION ? 250 : 0)
 *
 * An operator types that into a form and a stranger's browser then asks for a
 * price computed from it. So the two things this must not be are obvious:
 * it must not be `eval`, and it must not be handed to a model. It is a
 * tokeniser and a Pratt parser over a deliberately tiny grammar, and the
 * result is a tree that can be evaluated as many times as there are visitors
 * without ever re-parsing.
 *
 * What the grammar has:
 *
 *   numbers            12, 3.5
 *   variables          BASE_VEHICLE_SIZE — resolved from the quote request
 *   arithmetic         + - * /                     (left-associative)
 *   comparison         < <= > >= == !=
 *   ternary            cond ? a : b                (right-associative)
 *   grouping           ( )
 *   unary              -x, !x
 *
 * What it deliberately does not have: function calls, property access,
 * assignment, strings, and any way to name anything the evaluator did not put
 * in scope. There is nothing to reach out of, which is the point.
 *
 * Money. Every number in a formula is in **major units**, because that is what
 * an operator types and what the PRD writes (`250`). The result is converted
 * to integer minor units exactly once, by `evaluateQuote()`, at the boundary
 * — the same rule the SDK keeps (invariant 4).
 */

export class FormulaError extends Error {
  constructor(message: string, readonly position?: number) {
    super(message);
  }
}

/* ----------------------------------------------------------- tokenising */

type TokenType = "number" | "name" | "op" | "(" | ")" | "?" | ":" | "end";
type Token = { type: TokenType; value: string; at: number };

const OPERATORS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "<", ">", "!"];

/** Kept small on purpose: every character not listed here is a syntax error. */
function tokenise(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;

    if (/\s/.test(char)) { i++; continue; }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+/.exec(source.slice(i))!;
      tokens.push({ type: "number", value: match[0], at: i });
      i += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ type: "name", value: match[0], at: i });
      i += match[0].length;
      continue;
    }

    if (char === "(" || char === ")") { tokens.push({ type: char, value: char, at: i }); i++; continue; }
    if (char === "?") { tokens.push({ type: "?", value: "?", at: i }); i++; continue; }
    if (char === ":") { tokens.push({ type: ":", value: ":", at: i }); i++; continue; }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (operator) { tokens.push({ type: "op", value: operator, at: i }); i += operator.length; continue; }

    throw new FormulaError(`Unexpected character "${char}"`, i);
  }

  tokens.push({ type: "end", value: "", at: source.length });
  return tokens;
}

/* -------------------------------------------------------------- parsing */

export type Node =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: "-" | "!"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "ternary"; condition: Node; whenTrue: Node; whenFalse: Node };

/** Higher binds tighter. Ternary is handled separately, below everything. */
const PRECEDENCE: Record<string, number> = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6,
};

/**
 * How deeply a formula may nest.
 *
 * The parser recurses, so nesting depth — not source length — is what turns a
 * form field into a stack overflow: 1,500 open parentheses is 1,501
 * characters and 1,500 frames. Twenty is far past any expression a person
 * writes and far short of anything that hurts.
 */
const MAX_DEPTH = 20;

class Parser {
  private index = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek() { return this.tokens[this.index]!; }
  private next() { return this.tokens[this.index++]!; }

  private expect(type: TokenType, what: string) {
    const token = this.next();
    if (token.type !== type) {
      throw new FormulaError(`Expected ${what}${token.value ? `, found "${token.value}"` : ""}`, token.at);
    }
    return token;
  }

  parse(): Node {
    const node = this.expression(0);
    const trailing = this.peek();
    if (trailing.type !== "end") {
      throw new FormulaError(`Unexpected "${trailing.value}" after the end of the expression`, trailing.at);
    }
    return node;
  }

  private expression(minPrecedence: number): Node {
    let left = this.unary();

    for (;;) {
      const token = this.peek();

      // Ternary binds loosest and is right-associative, so it is only taken
      // when nothing tighter is in progress.
      if (token.type === "?" && minPrecedence === 0) {
        this.next();
        const whenTrue = this.expression(0);
        this.expect(":", "\":\"");
        const whenFalse = this.expression(0);
        left = { kind: "ternary", condition: left, whenTrue, whenFalse };
        continue;
      }

      if (token.type !== "op") break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;

      this.next();
      const right = this.expression(precedence + 1);
      left = { kind: "binary", op: token.value, left, right };
    }

    return left;
  }

  private unary(): Node {
    const token = this.peek();
    if (token.type === "op" && (token.value === "-" || token.value === "!")) {
      this.next();
      return { kind: "unary", op: token.value as "-" | "!", operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.next();

    if (token.type === "number") return { kind: "number", value: Number(token.value) };
    if (token.type === "name") return { kind: "variable", name: token.value };
    if (token.type === "(") {
      if (++this.depth > MAX_DEPTH) {
        throw new FormulaError(`The formula nests more than ${MAX_DEPTH} deep`, token.at);
      }
      const inner = this.expression(0);
      this.depth--;
      this.expect(")", "\")\"");
      return inner;
    }

    throw new FormulaError(
      token.type === "end" ? "The expression ended early" : `Unexpected "${token.value}"`,
      token.at,
    );
  }
}

/** Parses once. Throws `FormulaError` with a position on anything malformed. */
export function parseFormula(source: string): Node {
  if (!source.trim()) throw new FormulaError("The formula is empty");
  // A bound on nesting as well as on length: the parser recurses, and a
  // thousand open parentheses from a form field is a stack overflow.
  if (source.length > 2_000) throw new FormulaError("The formula is too long");
  return new Parser(tokenise(source)).parse();
}

/** Every variable a formula reads, so the form can ask for exactly those. */
export function variablesIn(node: Node): string[] {
  const found = new Set<string>();
  const walk = (current: Node) => {
    switch (current.kind) {
      case "variable": found.add(current.name); break;
      case "unary": walk(current.operand); break;
      case "binary": walk(current.left); walk(current.right); break;
      case "ternary": walk(current.condition); walk(current.whenTrue); walk(current.whenFalse); break;
      case "number": break;
    }
  };
  walk(node);
  return [...found].sort();
}

/* ----------------------------------------------------------- evaluating */

export type FormulaScope = Record<string, number | boolean>;

const asNumber = (value: number | boolean) => (typeof value === "boolean" ? (value ? 1 : 0) : value);
const asBoolean = (value: number | boolean) => (typeof value === "boolean" ? value : value !== 0);

/**
 * Evaluates a parsed formula against a scope.
 *
 * A variable the scope does not hold is an error, never a zero. Silently
 * treating a missing `PAINT_CORRECTION` as false would quote a price the
 * business never agreed to and nobody would find out until the invoice.
 */
export function evaluateFormula(node: Node, scope: FormulaScope): number | boolean {
  switch (node.kind) {
    case "number":
      return node.value;

    case "variable": {
      // `Object.hasOwn`, never `in`. Every object literal inherits
      // `constructor`, `toString`, `hasOwnProperty` and `__proto__` from
      // `Object.prototype`, so `"__proto__" in scope` is true for a scope
      // that has never heard of it — and the lookup then returns a function
      // or the prototype itself, which flows into the arithmetic below as
      // `NaN` and out the other side as a price. A formula is written by an
      // operator and evaluated for a stranger; the names it may resolve are
      // exactly the ones somebody put in the scope.
      if (!Object.hasOwn(scope, node.name)) {
        throw new FormulaError(`No value was given for ${node.name}`);
      }
      const value = scope[node.name];
      if (typeof value !== "number" && typeof value !== "boolean") {
        throw new FormulaError(`${node.name} is not a number or a yes/no value`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new FormulaError(`${node.name} is not a usable number`);
      }
      return value;
    }

    case "unary":
      return node.op === "-" ? -asNumber(evaluateFormula(node.operand, scope)) : !asBoolean(evaluateFormula(node.operand, scope));

    case "ternary":
      return asBoolean(evaluateFormula(node.condition, scope))
        ? evaluateFormula(node.whenTrue, scope)
        : evaluateFormula(node.whenFalse, scope);

    case "binary": {
      const left = evaluateFormula(node.left, scope);

      // Short-circuit, so `A || B` does not demand a value for B when A is
      // already true — which is how an optional variable stays optional.
      if (node.op === "&&") return asBoolean(left) ? asBoolean(evaluateFormula(node.right, scope)) : false;
      if (node.op === "||") return asBoolean(left) ? true : asBoolean(evaluateFormula(node.right, scope));

      const right = evaluateFormula(node.right, scope);
      const a = asNumber(left);
      const b = asNumber(right);

      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/":
          // Refused rather than `Infinity`: a quote of Infinity renders as a
          // price, and the customer is the one who finds out.
          if (b === 0) throw new FormulaError("Division by zero");
          return a / b;
        case "<": return a < b;
        case "<=": return a <= b;
        case ">": return a > b;
        case ">=": return a >= b;
        case "==": return a === b;
        case "!=": return a !== b;
        default: throw new FormulaError(`Unknown operator "${node.op}"`);
      }
    }
  }
}

/**
 * A price, in integer minor units.
 *
 * The one conversion from the major units an operator writes, rounding half
 * away from zero. A formula that produces a negative price, or one that is not
 * a finite number, is refused — both are numbers that would render as a quote.
 */
export function evaluateQuote(node: Node, scope: FormulaScope): number {
  const raw = asNumber(evaluateFormula(node, scope));
  if (!Number.isFinite(raw)) throw new FormulaError("The formula did not produce a usable number");
  if (raw < 0) throw new FormulaError("The formula produced a negative price");

  const scaled = raw * 100;
  return Math.round(scaled);
}
