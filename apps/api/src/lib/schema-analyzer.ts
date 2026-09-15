export interface SchemaForeignKey {
  column: string;
  referencesTable: string;
}

export interface SchemaTable {
  name: string;
  columns: string[];
  foreignKeys: SchemaForeignKey[];
  indexes: string[];
}

export interface SchemaAnalysis {
  dialect: "drizzle" | "prisma" | "sql" | "unknown";
  tables: SchemaTable[];
  exportNameToTable: Map<string, string>;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function splitDrizzleTables(text: string): Array<{ name: string; block: string }> {
  const headerRe = /export\s+const\s+(\w+)\s*=\s*pgTable\s*\(\s*["']([^"']+)["']/g;
  const matches = [...text.matchAll(headerRe)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? text.length)
        : text.length;
    return { name: match[2], block: text.slice(start, end) };
  });
}

function parseDrizzleColumns(block: string): string[] {
  const columnRe =
    /\b(?:uuid|varchar|text|integer|bigint|boolean|timestamp|jsonb|serial|numeric)\(\s*["']([^"']+)["']/g;
  return unique([...block.matchAll(columnRe)].map((m) => m[1]));
}

function parseDrizzleForeignKeys(
  block: string,
  exportNameToTable: Map<string, string>
): SchemaForeignKey[] {
  const fks: SchemaForeignKey[] = [];
  const fkRe =
    /(\w+)\s*:\s*uuid\([^)]*\)[\s\S]*?\.references\s*\(\s*\(\)\s*=>\s*(\w+)\./g;
  for (const match of block.matchAll(fkRe)) {
    const parent = exportNameToTable.get(match[2]) ?? match[2];
    fks.push({ column: match[1], referencesTable: parent });
  }
  return fks;
}

function parseDrizzleIndexes(block: string, tableName: string): string[] {
  const indexes = [
    ...[...block.matchAll(/uniqueIndex\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...block.matchAll(/\bindex\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
  ];
  if (/\.primaryKey\s*\(/.test(block)) {
    indexes.push(`${tableName}_pkey`);
  }
  return unique(indexes);
}

function analyzeDrizzle(text: string): SchemaAnalysis | null {
  const chunks = splitDrizzleTables(text);
  if (chunks.length === 0) return null;

  const exportNameToTable = new Map<string, string>();
  for (const match of text.matchAll(
    /export\s+const\s+(\w+)\s*=\s*pgTable\s*\(\s*["']([^"']+)["']/g
  )) {
    exportNameToTable.set(match[1], match[2]);
  }

  const tables = chunks.map(({ name, block }) => ({
    name,
    columns: parseDrizzleColumns(block),
    foreignKeys: parseDrizzleForeignKeys(block, exportNameToTable),
    indexes: parseDrizzleIndexes(block, name),
  }));

  return { dialect: "drizzle", tables, exportNameToTable };
}

function analyzePrisma(text: string): SchemaAnalysis | null {
  const modelRe = /^model\s+(\w+)\s*\{/gm;
  const matches = [...text.matchAll(modelRe)];
  if (matches.length === 0) return null;

  const tables: SchemaTable[] = matches.map((match, index) => {
    const modelName = match[1];
    const start = match.index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? text.length)
        : text.length;
    const block = text.slice(start, end);
    const tableName = modelName.charAt(0).toLowerCase() + modelName.slice(1);
    const columns = unique(
      [...block.matchAll(/^\s+(\w+)\s+\w+/gm)].map((m) => {
        const field = m[1];
        if (field === "model") return "";
        return field.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
      }).filter(Boolean)
    );
    const foreignKeys: SchemaForeignKey[] = [];
    for (const fk of block.matchAll(/(\w+)\s+\w+.*@relation\(fields:\s*\[(\w+)\]/g)) {
      foreignKeys.push({
        column: fk[2],
        referencesTable: fk[1].charAt(0).toLowerCase() + fk[1].slice(1),
      });
    }
    return {
      name: tableName,
      columns,
      foreignKeys,
      indexes: [],
    };
  });

  return { dialect: "prisma", tables, exportNameToTable: new Map() };
}

function analyzeSql(text: string): SchemaAnalysis | null {
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(/gi;
  const matches = [...text.matchAll(createRe)];
  if (matches.length === 0) return null;

  const tables: SchemaTable[] = matches.map((match, index) => {
    const name = match[1];
    const start = match.index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? text.length)
        : text.length;
    const block = text.slice(start, end);
    const columns = unique(
      [...block.matchAll(/^\s*["']?(\w+)["']?\s+\w+/gim)]
        .map((m) => m[1])
        .filter((c) => !/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)$/i.test(c))
    );
    const foreignKeys: SchemaForeignKey[] = [];
    for (const fk of block.matchAll(
      /FOREIGN\s+KEY\s*\(["']?(\w+)["']?\)\s*REFERENCES\s+["']?(\w+)["']?/gi
    )) {
      foreignKeys.push({ column: fk[1], referencesTable: fk[2] });
    }
    return { name, columns, foreignKeys, indexes: [] };
  });

  return { dialect: "sql", tables, exportNameToTable: new Map() };
}

export function analyzeSchema(schemaText: string): SchemaAnalysis | null {
  const text = schemaText.trim();
  if (text.includes("pgTable(")) {
    return analyzeDrizzle(text);
  }
  if (/^model\s+\w+/m.test(text)) {
    return analyzePrisma(text);
  }
  if (/CREATE\s+TABLE/i.test(text)) {
    return analyzeSql(text);
  }
  return null;
}
