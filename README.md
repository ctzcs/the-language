# The Language - Jai Language support

VSCode extension for Jai language support.

Syntax highlighting:
![Screenshot](media/screenshot1.png)

Highlight language inside herestring (postfix `HERE` with language ID)...
![Screenshot](media/screenshot2.png)

...which lets you nicely embed shaders
![Screenshot](media/screenshot3.png)

Uses Markdown for docstrings
![Screenshot](media/screenshot4.png)

Comment tags + checklists
![Screenshot](media/screenshot5.png)

Autocomplete x64 instructions
![Screenshot](media/asmcomplete.gif)


# IDE-like functionality

Supports Jai beta **0.2.009**. Compiler-backed definition, references, and rename
use the metaprogram plugin interface. A tolerant source index also provides
navigation, hover documentation, signature help, scope-aware completions, struct
and module members, type definitions, document outlines, and workspace symbols
while editing incomplete or unsaved code.

The compiler is discovered on `PATH` by default. Configure the project entry
point when it is not a conventional `build.jai`, `main.jai`, or `first.jai` at the
workspace root. Absolute paths and paths relative to the workspace are accepted:

```json
{
    "the-language.pathToJaiExecutable": "jai",
    "the-language.projectFile": "build.jai",
    "the-language.projectJaiArgs": "-import_dir \"D:/my modules\""
}
```

Saving any Jai source file in the project refreshes its compiler index, including
helper files without `main`. Changes invalidate stale locations immediately;
unsaved buffers are indexed without overwriting files or saving them implicitly.
Use **Jai: Refresh Project Index** to request a rebuild, and the **Jai** output
channel for compiler discovery and analysis errors. Disabling background
compilation leaves source-based editor features available.

F12 also opens `#load` and `#import` string targets. Module lookup respects
`projectJaiArgs` import directories and the modules shipped beside the selected
compiler. Filename and module-name completion is available inside those strings.
Custom metaprograms must support the standard plugin interception interface.

The source index is deliberately conservative: it is not a replacement for Jai's
type checker, macro expansion, or build-time condition evaluation. Complex
generated and polymorphic expressions may require a successful compilation.
Global/member rename requires a current compiler index; local rename can use
unsaved code and checks lexical scope and name collisions. Formatting, call
hierarchy, and semantic tokens are not provided.

## Development

```sh
npm ci
npm run compile
npm run lint
npm run test:unit
npm test
npm run package
```

Compilation copies the navigation plugin and assembly metadata to `out`, so a
VSIX includes all runtime assets. Integration tests use a separate VS Code
profile. Set `VSCODE_TEST_EXECUTABLE` to an existing VS Code executable to avoid
downloading one, and optionally `JAI_TEST_COMPILER` to select a compiler for
compiler regression tests. Compiler tests are skipped when Jai is unavailable.
