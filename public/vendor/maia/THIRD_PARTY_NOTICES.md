# Maia browser engine notices

Backranq's integration and preprocessing code in this repository is an
independent implementation. It does not copy source code from the Maia Chess
Platform frontend.

## ONNX Runtime Web

- Package: `onnxruntime-web@1.27.0`
- Project: https://github.com/microsoft/onnxruntime
- Copyright: Microsoft Corporation
- License: MIT

The generated worker and copied WebAssembly runtime contain ONNX Runtime Web.
The MIT permission notice is:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Maia 3 simplified ONNX model

The model is not bundled with Backranq. It is fetched only after a user opts
into Maia and is then cached locally in that browser.

- Upstream project: https://github.com/CSSLab/maia3
- External artifact:
  https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/0013cc8e6ec52c88f5b3d694781d4cc8427cb91a/public/maia3/maia3_simplified.onnx
- Introducing upstream commit: `0013cc8e6ec52c88f5b3d694781d4cc8427cb91a`
- Size: `45,683,686` bytes
- SHA-256:
  `405bf76c15727dad8728b352c06a8f3c1b80fb2760e8d666b32485c63d75b856`

The Maia 3 model card says to consult the repository for the code/weights
license. The Maia 3 code repository uses AGPL-3.0 and the repository hosting
this simplified artifact uses GPL-3.0, but neither currently gives this ONNX
artifact an unambiguous standalone weights license. Redistribution and
production use therefore require a license review or explicit permission from
CSSLab. This notice documents the uncertainty; it does not grant a license.
