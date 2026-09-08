# Third-party provenance and notices

## Internal supervisor

`src/internal/supervisor/` and `test/internal-supervisor/` were moved from
[wassname/pi-supervise](https://github.com/wassname/pi-supervise) (formerly
pi-intercom-supervisor), commit `145c2cb081f85c08b0244c4a2c8a2d9aef8debda`.
The source package is `@wassname2/pi-supervise` 0.0.4, author wassname, declared
license MIT. The source comments and attribution are retained. Local changes
integrate package loading, role-model readiness, duplicate-registration diagnostics,
and strict build/lint compatibility. Its synthetic fork fixture is retained; it
contains no user transcript.

The supervisor's `subagents.ts` retains its attribution to
`@monotykamary/pi-supervisor` (MIT), `src/subagent-detector.ts`. Its policy precedence
also follows that project. No separate supervisor package is required at runtime.

### MIT license

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Bundled dependencies

- `pi-intercom` 0.10.0: existing Intercom transport and broker; MIT. Its upstream
  LICENSE is included under `node_modules/pi-intercom/LICENSE` in the package.
- `@sting8k/pi-vcc` 0.5.0: existing algorithmic worker-view compiler. Its README's
  License section declares MIT and is included with the bundled source.
- Intercom's runtime dependencies, including `tsx` and `esbuild`, retain their
  upstream package notices in the tarball. Pi core and typebox are peers, not bundled.

No replacement IPC runtime or VCC implementation was written for this move.
