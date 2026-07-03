# サードパーティライセンス表記

## emu2413

YM2413（OPLL）互換のソフトウェア音源実装。効果音の音源コアとして使用しています。

- 作者: Mitsutaka Okazaki
- リポジトリ: https://github.com/digital-sound-antiques/emu2413
- 同梱場所: `vendor/emu2413/`（`src/ui/emu2413.wasm` はここからビルド。手順は `tools/wasm/build-opll-wasm.sh`）
- ライセンス: MIT License（全文は下記および `vendor/emu2413/LICENSE`）

```
The MIT License (MIT)

Copyright (c) 2001-2019 Mitsutaka Okazaki

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
```

補足: 効果音そのもの（キュイン・コイン払い出し等のシーケンス）は、実機音源の
吸い出しではなく、本プロジェクトが内蔵音色 + レジスタ操作で独自に定義したものです。
「YM2413」「OPLL」はヤマハ株式会社の製品型番であり、本プロジェクトは互換実装で
あることの説明のためにのみ使用しています。
