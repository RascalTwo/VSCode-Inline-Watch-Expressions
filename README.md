# inline-watch-expressions

Adds watch expression values inline to the document.

## Usage

While it will visualize any watch expression, to reduce clutter you can use these add/remove/reset commands on a selected expression on the page to only inline the expression to certain locations.

- `inline-watch-expressions.add-inline-watch-expression-decorator`
  - Add inline watch expression decorator to the selected text
- `inline-watch-expressions.remove-inline-watch-expression-decorator`
  - Remove inline watch expression decorator from the selected text
- `inline-watch-expressions.reset-inline-watch-expression-decorators`
  - Reset added inline watch expression decorators

## Installation

As it's not on the VSCode marketplace yet, one must must manually build & install it as so:

- Clone the repository
  - `git clone https://github.com/RascalTwo/VSCode-Inline-Watch-Expressions.git`
- Install dependencies
	- `npm install`
- Build the extension
  - `npx vsce package`
  - Answer `Y` to all questions
- Install the extension
  - `code --install-extension inline-watch-expressions-X.Y.Z.vsix`

After this, you can use the extension as normal.
