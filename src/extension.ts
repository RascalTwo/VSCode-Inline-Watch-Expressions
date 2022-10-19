// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { enableHotReload, hotRequireExportedFn, registerUpdateReconciler } from '@hediet/node-reload';
import { Disposable } from '@hediet/std/disposable';

type WatchedValue = {
  expression: string;
  seq: number;
  value?: { type: string; result: string };
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
  /** RegExp match */
  match: RegExpExecArray;
}

/**
 * Return {@link ExpressionLocation expression locations} within the provided {@link document}.
 */
function* getExpressionLocations(
  haystack: string,
  expressions: Iterable<[string, any]>,
): Generator<ExpressionLocation> {
  for (const [expression, value] of expressions) {
    // Must begin with a whitespace or word border, and end with whitespace, word border, or one of []()`
    const regex = new RegExp('(\\s|\\b)' + escapeRegExp(expression) + '(\\s|\\b|\[|\]|\(|\)|`)', 'gm');
    let match;
    while ((match = regex.exec(haystack))) {
      yield {
        expression,
        value,
        match,
      };
    }
  }
}

/**
 * Generate decorators on the {@link document} from the provided {@link expressionLocations expression locations}.
 */
function generateDecorators(document: vscode.TextDocument, expressionLocations: ExpressionLocation[]) {
  return expressionLocations
    .sort((a, b) => a.expression.length - b.expression.length)
    .map(({ match, value }) => {
      const start = document.positionAt(match.index);
      const end = document.positionAt(match.index + match[0].length);

      // Move start/end range to exclude whitespace
      const prefixOffset = match[0].trimStart() !== match[0] ? match[0].length - match[0].trimStart().length : 0;
      const suffixOffset = match[0].trimEnd() !== match[0] ? match[0].length - match[0].trimEnd().length : 0;

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
            contentText: ` === ${value})`,
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
          editor.document.getText(),
          // Filter out all expressions that don't have a value
          [...this.expression.value.entries()]
            .filter(([_, watch]) => watch.value?.result)
            .map(([expression, watch]) => [expression, watch.value!.result]),
        ),
      ]),
    );
  }

  clearExpressions() {
    this.expression.value.clear();
    this.expression.request.clear();
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
      const obj = {
        seq: message.seq,
        expression: message.arguments.expression,
        value: undefined,
      };
      this.expression.value.set(message.arguments.expression, obj);
      this.expression.request.set(message.seq, obj);
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
