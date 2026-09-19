/**
 * Split a SQL script into individual statements.
 *
 * Naively splitting on ';' corrupts this schema: the seed migration is one
 * `DO $seed$ ... $seed$` block full of semicolons, and trigger bodies use
 * `$$ ... $$`. This walks the text tracking line comments, block comments,
 * single-quoted literals and dollar-quoted strings so a ';' only terminates a
 * statement when it appears at the top level.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }

    // /* block comment */ — nests in PostgreSQL
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }

    // 'single quoted' — '' is an escaped quote
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // "quoted identifier"
    if (ch === '"') {
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      i++;
      continue;
    }

    // $tag$ dollar-quoted string $tag$
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        i = end === -1 ? sql.length : end + marker.length;
        continue;
      }
    }

    if (ch === ';') {
      const stmt = sql.slice(start, i).trim();
      if (stmt.length > 0) statements.push(stmt);
      start = i + 1;
    }

    i++;
  }

  const tail = sql.slice(start).trim();
  if (tail.length > 0) statements.push(tail);

  return statements;
}
