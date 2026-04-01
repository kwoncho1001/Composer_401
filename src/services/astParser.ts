import { parse } from '@babel/parser';

export interface LogicUnit {
  title: string;
  code: string;
  startLine: number;
  endLine: number;
}

// Simple AST walker to find specific nodes
function walk(node: any, visitor: (n: any) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(child => walk(child, visitor));
    return;
  }
  visitor(node);
  for (const key in node) {
    if (key !== 'loc' && key !== 'start' && key !== 'end' && key !== 'comments') {
      walk(node[key], visitor);
    }
  }
}

// Check if a function contains JSX
function hasJSX(node: any): boolean {
  let found = false;
  walk(node, (n) => {
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') found = true;
  });
  return found;
}

const getCodeSnippet = (lines: string[], startLine: number, endLine: number) => {
  return lines.slice(startLine - 1, endLine).join('\n');
};

export function parseCodeToNodes(filePath: string, code: string): LogicUnit[] {
  const units: LogicUnit[] = [];
  const lines = code.split('\n');

  try {
    const plugins: any[] = ['jsx'];
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      plugins.push('typescript');
    }

    const ast = parse(code, {
      sourceType: 'module',
      plugins,
    });

    ast.program.body.forEach((node: any) => {
      if (!node.loc) return;
      let title = '';

      if (node.type === 'FunctionDeclaration') {
        title = node.id?.name || 'AnonymousFunction';
      } else if (node.type === 'ClassDeclaration') {
        title = node.id?.name || 'AnonymousClass';
      } else if (node.type === 'VariableDeclaration') {
        const decl = node.declarations[0];
        if (decl && decl.id && decl.id.type === 'Identifier') {
          title = decl.id.name;
        }
      } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
        const declaration = node.declaration;
        if (declaration) {
          if (declaration.type === 'FunctionDeclaration') {
            title = declaration.id?.name || 'ExportedFunction';
          } else if (declaration.type === 'ClassDeclaration') {
            title = declaration.id?.name || 'ExportedClass';
          } else if (declaration.type === 'VariableDeclaration') {
            const decl = declaration.declarations[0];
            if (decl && decl.id && decl.id.type === 'Identifier') {
              title = decl.id.name;
            }
          } else if (node.type === 'ExportDefaultDeclaration') {
            title = filePath.split('/').pop()?.split('.')[0] + '_Default';
          }
        } else if (node.type === 'ExportDefaultDeclaration') {
           title = filePath.split('/').pop()?.split('.')[0] + '_Default';
        }
      }

      if (title) {
        // Treat every top-level declaration (including React components) as a single logic unit.
        // This prevents excessive fragmentation and API timeouts.
        units.push({
          title,
          code: getCodeSnippet(lines, node.loc.start.line, node.loc.end.line),
          startLine: node.loc.start.line,
          endLine: node.loc.end.line,
        });
      }
    });

  } catch (error) {
    console.error(`Failed to parse AST for ${filePath}:`, error);
    units.push({
      title: filePath.split('/').pop() || 'UnknownFile',
      code: code,
      startLine: 1,
      endLine: lines.length,
    });
  }

  return units;
}
