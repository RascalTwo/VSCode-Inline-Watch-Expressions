// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { enableHotReload, hotRequireExportedFn, registerUpdateReconciler } from '@hediet/node-reload';
import { Disposable } from '@hediet/std/disposable';

type WatchedValue = {
  expression: string;
  value?: { type: string; result: string };
  renderAt: vscode.Range[];
};

if (process.env.NODE_ENV === 'development') {
  // only activate hot reload while developing the extension
  enableHotReload({ entryModule: module, loggingEnabled: true });
}
registerUpdateReconciler(module);

/**
 * Escape regular expression special characters in a string.
 */
function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create a debounced function of {@link fn} delaying calls by {@link ms}
 */
function debounce(func: () => void, milliseconds: number) {
  let timeout: NodeJS.Timeout;
  return () => {
    clearTimeout(timeout);
    timeout = setTimeout(func, milliseconds);
  };
}

interface ExpressionLocation {
  /** Expression being watched */
  expression: string;
  /** Current Value of expression */
  value: any;
  text: string;
  start: vscode.Position;
}

/**
 * Return {@link ExpressionLocation expression locations} within the provided {@link document}.
 */
function* getExpressionLocations(
  document: vscode.TextDocument,
  expressions: Iterable<[string, WatchedValue]>,
): Generator<ExpressionLocation> {
  const haystack = document.getText();

  for (const [expression, watch] of expressions) {
    const value = watch.value!.result;

    if (watch.renderAt.length) {
      for (const range of watch.renderAt) {
        yield {
          expression,
          value,
          text: expression,
          start: range.start,
        };
      }
    } else {
      // Must begin with a whitespace or word border, and end with whitespace, word border, or one of []()
      const regex = new RegExp('(\\s|\\b)' + escapeRegExp(expression) + '(\\s|\\b|[|]|(|))', 'gm');
      let match;
      while ((match = regex.exec(haystack))) {
        yield {
          expression,
          value,
          text: match[0],
          start: document.positionAt(match.index),
        };
      }
    }
  }
}

/**
 * Generate decorators on the {@link document} from the provided {@link expressionLocations expression locations}.
 */
function generateDecorators(
  document: vscode.TextDocument,
  expressionLocations: ExpressionLocation[],
): vscode.DecorationOptions[] {
  return expressionLocations
    .sort((a, b) => a.expression.length - b.expression.length)
    .map(({ text, start, value }) => {
      const end = document.positionAt(document.offsetAt(start) + text.length);

      // Move start/end range to exclude whitespace
      const prefixOffset = text.trimStart() !== text ? text.length - text.trimStart().length : 0;
      const suffixOffset = text.trimEnd() !== text ? text.length - text.trimEnd().length : 0;

      // Roll end position to previous line if character is negative
      const [endLine, endChar] =
        end.character - suffixOffset < 0
          ? [end.line - 1, document.lineAt(end.line - 1).text.length]
          : [end.line, end.character - suffixOffset];

      return {
        range: new vscode.Range(
          new vscode.Position(start.line, start.character + prefixOffset),
          new vscode.Position(endLine, endChar),
        ),
        renderOptions: {
          before: {
            contentText: '(',
            color: 'grey',
            fontStyle: 'italic',
          },
          after: {
            contentText: ` = ${value})`,
            color: 'grey',
            fontStyle: 'italic',
          },
        },
      };
    });
}

class Extension implements vscode.DebugAdapterTracker {
  public dispose = Disposable.fn();
  private decorationType = vscode.window.createTextEditorDecorationType({});
  private expression: {
    /** {@link WatchedValue} lookup via expression string */
    value: Map<string, WatchedValue>;
    /** {@link WatchedValue} lookup via seq ID */
    request: Map<number, WatchedValue>;
  } = {
    value: new Map(),
    request: new Map(),
  };
  constructor() {
    this.dispose.track(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: () => this,
      }),
    );

    this.dispose.track(
      vscode.commands.registerTextEditorCommand(
        'inline-watch-expressions.add-inline-watch-expression-decorator',
        async editor => {
          const expression = editor.document.getText(editor.selection);
          if (!expression) {
            return vscode.window.showInformationMessage('No expression selected');
          }

          const existingWatch = this.expression.value.get(expression);
          if (existingWatch) {
            existingWatch.renderAt = [
              ...existingWatch.renderAt.filter(range => !range.intersection(editor.selection)),
              editor.selection,
            ];
          } else {
            this.expression.value.set(expression, {
              expression,
              renderAt: [editor.selection],
            });
            await vscode.commands.executeCommand('editor.debug.action.selectionToWatch');
          }

          this.queueDecoratorUpdate();

          return vscode.window.showInformationMessage(existingWatch ? 'Updated watch' : 'Added watch');
        },
      ),
    );

    this.dispose.track(
      vscode.commands.registerTextEditorCommand(
        'inline-watch-expressions.remove-inline-watch-expression-decorator',
        async editor => {
          const expression = editor.document.getText(editor.selection);
          if (!expression) {
            return vscode.window.showInformationMessage('No expression selected');
          }

          const existingWatch = this.expression.value.get(expression);
          if (existingWatch) {
            existingWatch.renderAt = existingWatch.renderAt.filter(range => !range.intersection(editor.selection));

            this.queueDecoratorUpdate();
          }

          return vscode.window.showInformationMessage(existingWatch ? 'Removed watch' : 'No watch found');
        },
      ),
    );

    this.dispose.track(
      vscode.commands.registerCommand('inline-watch-expressions.reset-inline-watch-expression-decorators', () => {
        this.clearExpressions();
        return vscode.window.showInformationMessage('Removed all watches');
      }),
    );
  }

  queueDecoratorUpdate = debounce(this.updateDecorators.bind(this), 500);

  async updateDecorators() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    this.decorationType.dispose();
    this.decorationType = vscode.window.createTextEditorDecorationType({});
    editor.setDecorations(
      this.decorationType,
      generateDecorators(editor.document, [
        ...getExpressionLocations(
          editor.document,
          // Filter out all expressions that don't have a value
          [...this.expression.value.entries()].filter(([_, watch]) => watch.value?.result),
        ),
      ]),
    );
  }

  clearExpressions() {
    this.expression.value.clear();
    this.expression.request.clear();
    this.queueDecoratorUpdate();
  }

  onWillStartSession = this.clearExpressions;
  onWillStopSession = this.clearExpressions;

  onDidSendMessage(message: any) {
    // If message is a response to the evaluate command that isn't an error and is expected, set value and queue decorator update
    if (
      message.type === 'response' &&
      message.command === 'evaluate' &&
      !message.body.error &&
      this.expression.request.has(message.request_seq)
    ) {
      this.expression.request.get(message.request_seq)!.value = message.body;
      this.queueDecoratorUpdate();
    }
  }
  onWillReceiveMessage(message: any) {
    // Clear expression when debugging step is made (to clear out removed watched values)
    if (message.command === 'next') {
      this.clearExpressions();
      // If evaluation request is made via the watch window, add watch object to expression maps
    } else if (message.command === 'evaluate' && message.type === 'request' && message.arguments.context === 'watch') {
      const expression = message.arguments.expression;

      const existingWatch = this.expression.value.get(expression);
      if (existingWatch) {
        this.expression.request.set(message.seq, existingWatch!);
      } else {
        const newWatch = {
          expression,
          value: undefined,
          renderAt: [],
        };
        this.expression.value.set(expression, newWatch);
        this.expression.request.set(message.seq, newWatch);
      }
    }
  }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(hotRequireExportedFn(module, Extension, Extension => new Extension()));
}

// This method is called when your extension is deactivated
export function deactivate() {}
