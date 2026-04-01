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

    // Deep AST Parsing for React Components
    const processFunctionBody = (funcNode: any, funcName: string) => {
      const body = funcNode.body;
      if (!body || body.type !== 'BlockStatement') {
        units.push({
          title: funcName,
          code: getCodeSnippet(lines, funcNode.loc.start.line, funcNode.loc.end.line),
          startLine: funcNode.loc.start.line,
          endLine: funcNode.loc.end.line
        });
        return;
      }

      let stateStartLine = -1;
      let stateEndLine = -1;

      const pushStateUnit = () => {
        if (stateStartLine !== -1) {
          units.push({
            title: `${funcName}_StateSetup`,
            code: getCodeSnippet(lines, stateStartLine, stateEndLine),
            startLine: stateStartLine,
            endLine: stateEndLine
          });
          stateStartLine = -1;
        }
      };

      body.body.forEach((stmt: any) => {
        if (!stmt.loc) return;
        const start = stmt.loc.start.line;
        const end = stmt.loc.end.line;

        let isStateHook = false;
        if (stmt.type === 'VariableDeclaration') {
          isStateHook = stmt.declarations.some((decl: any) => {
            return decl.init && decl.init.type === 'CallExpression' &&
                   decl.init.callee.type === 'Identifier' &&
                   decl.init.callee.name.startsWith('use') &&
                   !['useEffect', 'useCallback', 'useMemo'].includes(decl.init.callee.name);
          });
        }

        if (isStateHook) {
          if (stateStartLine === -1) stateStartLine = start;
          stateEndLine = end;
        } else {
          pushStateUnit();

          if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression') {
            const callee = stmt.expression.callee;
            if (callee.type === 'Identifier' && callee.name === 'useEffect') {
              units.push({
                title: `${funcName}_Effect_${start}`,
                code: getCodeSnippet(lines, start, end),
                startLine: start,
                endLine: end
              });
            } else {
              units.push({
                title: `${funcName}_Expression_${start}`,
                code: getCodeSnippet(lines, start, end),
                startLine: start,
                endLine: end
              });
            }
          } else if (stmt.type === 'VariableDeclaration' || stmt.type === 'FunctionDeclaration') {
            let innerName = `${funcName}_InnerLogic_${start}`;
            if (stmt.type === 'FunctionDeclaration' && stmt.id) {
              innerName = stmt.id.name;
            } else if (stmt.type === 'VariableDeclaration') {
              const decl = stmt.declarations[0];
              if (decl && decl.id && decl.id.type === 'Identifier') {
                innerName = decl.id.name;
              }
            }
            units.push({
              title: innerName,
              code: getCodeSnippet(lines, start, end),
              startLine: start,
              endLine: end
            });
          } else if (stmt.type === 'ReturnStatement') {
            units.push({
              title: `${funcName}_Render`,
              code: getCodeSnippet(lines, start, end),
              startLine: start,
              endLine: end
            });
          } else {
            units.push({
              title: `${funcName}_LogicBlock_${start}`,
              code: getCodeSnippet(lines, start, end),
              startLine: start,
              endLine: end
            });
          }
        }
      });
      pushStateUnit();
    };

    ast.program.body.forEach((node: any) => {
      if (!node.loc) return;
      let title = '';
      let isFunc = false;
      let funcNode = null;

      if (node.type === 'FunctionDeclaration') {
        title = node.id?.name || 'AnonymousFunction';
        isFunc = true;
        funcNode = node;
      } else if (node.type === 'ClassDeclaration') {
        title = node.id?.name || 'AnonymousClass';
      } else if (node.type === 'VariableDeclaration') {
        const decl = node.declarations[0];
        if (decl && decl.id && decl.id.type === 'Identifier') {
          title = decl.id.name;
          if (decl.init && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')) {
            isFunc = true;
            funcNode = decl.init;
          }
        }
      } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
        const declaration = node.declaration;
        if (declaration) {
          if (declaration.type === 'FunctionDeclaration') {
            title = declaration.id?.name || 'ExportedFunction';
            isFunc = true;
            funcNode = declaration;
          } else if (declaration.type === 'ClassDeclaration') {
            title = declaration.id?.name || 'ExportedClass';
          } else if (declaration.type === 'VariableDeclaration') {
            const decl = declaration.declarations[0];
            if (decl && decl.id && decl.id.type === 'Identifier') {
              title = decl.id.name;
              if (decl.init && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')) {
                isFunc = true;
                funcNode = decl.init;
              }
            }
          } else if (node.type === 'ExportDefaultDeclaration') {
            title = filePath.split('/').pop()?.split('.')[0] + '_Default';
            if (declaration.type === 'ArrowFunctionExpression' || declaration.type === 'FunctionExpression') {
              isFunc = true;
              funcNode = declaration;
            }
          }
        } else if (node.type === 'ExportDefaultDeclaration') {
           title = filePath.split('/').pop()?.split('.')[0] + '_Default';
        }
      }

      if (title) {
        if (isFunc && funcNode && hasJSX(funcNode)) {
          // It's a React Component! Apply Deep AST Parsing
          processFunctionBody(funcNode, title);
        } else {
          // Normal top-level extraction
          units.push({
            title,
            code: getCodeSnippet(lines, node.loc.start.line, node.loc.end.line),
            startLine: node.loc.start.line,
            endLine: node.loc.end.line,
          });
        }
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
