import { describe, expect, it } from 'vitest';
import { splitStatements } from './sql-split.ts';

/**
 * This function exists because naive splitting on ';' corrupts the migration
 * chain, and it only runs for `@no-transaction` files — where a wrong split
 * fails part-applied, against a database that then has to be recreated. That is
 * an expensive way to find out, and end to end it is invisible: a migration
 * either applies or it does not, and the smoke suite never sees the statements.
 */
describe('splitStatements', () => {
  it('splits plain statements and drops the empty tail', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a final statement with no trailing semicolon', () => {
    expect(splitStatements('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores empty statements from doubled semicolons', () => {
    expect(splitStatements('SELECT 1;;\n\n;SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does not split inside a dollar-quoted block — the seed is one DO block', () => {
    const sql = "DO $seed$ BEGIN INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); END $seed$;";
    expect(splitStatements(sql)).toEqual([sql.slice(0, -1)]);
  });

  it('handles bare $$ quoting as used by trigger bodies', () => {
    const sql = "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;";
    expect(splitStatements(sql)).toEqual([sql.slice(0, -1)]);
  });

  it('does not confuse a different closing tag', () => {
    // $a$ must not be closed by $b$.
    const sql = "DO $a$ SELECT '$b$'; SELECT 1; $a$;";
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it('ignores a semicolon inside a string literal', () => {
    expect(splitStatements("SELECT ';'; SELECT 2;")).toEqual(["SELECT ';'", 'SELECT 2']);
  });

  it('handles the doubled-quote escape', () => {
    expect(splitStatements("SELECT 'it''s; fine'; SELECT 2;"))
      .toEqual(["SELECT 'it''s; fine'", 'SELECT 2']);
  });

  it('ignores a semicolon inside a quoted identifier', () => {
    expect(splitStatements('SELECT "odd;name"; SELECT 2;')).toEqual(['SELECT "odd;name"', 'SELECT 2']);
  });

  it('ignores a semicolon in a line comment', () => {
    expect(splitStatements('SELECT 1 -- ; not a split\n; SELECT 2;'))
      .toEqual(['SELECT 1 -- ; not a split', 'SELECT 2']);
  });

  it('ignores a semicolon in a block comment, and block comments nest', () => {
    expect(splitStatements('SELECT 1 /* a /* ; nested */ ; still */ ; SELECT 2;'))
      .toEqual(['SELECT 1 /* a /* ; nested */ ; still */', 'SELECT 2']);
  });

  it('returns nothing for whitespace alone', () => {
    expect(splitStatements('   \n\n  ')).toEqual([]);
  });

  it('emits a trailing comment as its own statement — known, and harmless', () => {
    // Comments are skipped for the purpose of finding ';', but `start` is not
    // advanced past them, so a comment after the last semicolon becomes a
    // statement of its own. PostgreSQL accepts a comment-only query and returns
    // an empty result, so applyOne simply issues a no-op.
    //
    // Documented rather than fixed: this only runs for @no-transaction files,
    // none of which ends in a comment (002, 004 and 008 all end with a real
    // statement, checked), and changing the split to satisfy a test would be
    // changing migration-runner semantics for a case that does not occur.
    expect(splitStatements('-- just a comment\n')).toEqual(['-- just a comment']);
  });

  it('does not hang on an unterminated dollar quote', () => {
    // A truncated file should produce one statement, not loop.
    expect(splitStatements('DO $x$ SELECT 1;')).toEqual(['DO $x$ SELECT 1;']);
  });
});
