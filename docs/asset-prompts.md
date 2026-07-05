# 画像アセット生成プロンプト仕様

音を「OPLL という当時の制約ごと再現」したのと同じ発想で、絵にも様式制約を立てる。
目標様式は **4 号機期の印刷シール調リール図柄**（白い縁取り + 黒キーライン + セル影 2〜3 段 +
グロスハイライト。小サイズで即判読）。フラットすぎると「悪い意味で 2 号機っぽく」なるので、
階調は必要（v1 の 64px・16 色フラットはこの理由で廃止）。
AI 生成のばらつきは後処理パイプライン（`npm run symbols`）が 32 色・128px に量子化して均す。

**背景は白でなくライトグレー（#d9d9d9）で生成すること。**
シールの白縁が白背景だと背景除去（フラッドフィル）に食われる。

## 図柄は横長（根拠つき）

- 回胴式遊技機の技術上の規格で、図柄の大きさは**縦 25mm 以上・横 35mm 以上**
  （= 最低でも横:縦 1.4:1 の横長）と規定されている
  （参考: パチセブン「6号機の遊技機規則を読んでみよう(11)」、note「ゼロから理解する
  回胴式遊技機に係る技術上の規格 Part2」）
- 実機リール帯の実測でも図柄の描画は概ね 2:1 前後。大物図柄（7・キャラ）は 2 コマ跨ぎもある
- 本シミュレータのコマ枠は約 1.6:1 → **アセットは 160×100px（1.6:1）**、
  生成は横長（1536×1024）で「wide and squat, filling the frame width」を指示する

## 権利ルール（音楽の PD 限定方針と同じ）

- プロンプトに**実在機種名・実在キャラクター・メーカー名を入れない**
- 「パチスロ風」「レトロスロット風」のような様式語は OK。特定作品の再現指示は NG

## 1. リール図柄シート

**1 プロンプト 1 枚で全図柄を同時生成する**（別々に生成するとスタイルがばらけるため）。
4×2 グリッドで 8 セル。生成後の切り出しはパイプラインが等分割で行うので、
「等間隔グリッド・各セル中央に 1 図柄・背景は無地白」が守られていることが重要。

### プロンプト（英語推奨。gpt-image 系向け）

```
High-grade Japanese pachislo reel symbol sheet, premium 1990s slot machine
print quality. A strict 4x2 grid of 8 cells on a plain flat light gray
background (hex d9d9d9), each symbol centered with generous margin,
no grid lines, no drop shadows on the background.
Every symbol is drawn as a glossy printed sticker: a thick white outline
border around the whole silhouette, a bold black keyline inside it,
cel shading with 2-3 tones per color, bright glossy highlights, rich
saturated colors, festival pop energy, detailed yet instantly readable
at small size, perfectly consistent rendering style across all 8 cells
like seals printed on a real reel strip.
Cells in order (left to right, top to bottom):
1. a bold red lucky number seven with a metallic two-tone red gradient and
   a small star sparkle, clearly readable as the numeral 7 with the diagonal
   descending from the right end of the top bar
2. a black rounded-rectangle BAR badge with white BAR letters and a gold trim line
3. a golden bell with a small red ribbon bow
4. a blue enamel medal badge of two arrows forming a circle (replay icon)
5. a pair of glossy red cherries with two green leaves
6. a juicy red watermelon slice with green rind
7. a cheerful cartoon green broccoli with a simple smiling face (vegetable mascot)
8. empty cell, plain background only
No real slot machine brands (no HANABI, no Aruze, no Juggler),
no existing characters, original design only.
```

- 推奨生成サイズ: 1536×1024 以上（横長）。数枚ガチャして一番揃っているものを採用
- 7 セル目のブロッコリーは純ブランクの伝統（獣王の木＝通称カリフラワー）へのオマージュ

### 後処理

```
npm run symbols -- sheet.png --grid 4x2 --names seven_red,bar,bell,replay,cherry,melon,blank,-
```

- `-` は捨てセル。出力は `src/ui/assets/symbols/<図柄ID>.png`（128px・32 色・透過）
- 図柄 ID はリール定義（machines/*.ts の strips）と一致させること:
  `seven_red / bar / bell / replay / cherry / melon / blank`
- 検証 NG（背景が残る・消えすぎ）が出たら `--tolerance` を上下（既定 90。背景残り → 120、消えすぎ → 60）
- 1 図柄だけ再生成したいとき: `npm run symbols -- one.png --name bell`

### 合格基準（パイプラインが機械検証）

- 32 色以内 / 不透明率 10〜98% / 正方形
- 目視: 3 コマ縦並び（実寸 64〜120px）で図柄が判別できる・白縁が欠けていない・
  参考実機級の「シールが貼ってある」立体感がある

## 2. 筐体上部パネル（1 枚絵）

単発の絵なのでスタイル整合の問題がなく、**AI 生成が最も得意な部分**。
`src/ui/assets/panel.png` に置くと筐体上部に表示される（横長・上下トリム表示）。

### プロンプト例

```
Retro Japanese slot machine top panel artwork, 1990s pachislo cabinet style.
Wide horizontal banner composition. Original fictional machine title logo
"DAREDEMO SLOT" in bold retro lettering, surrounded by dynamic rays,
stars and neon gradients. Vivid saturated colors, airbrush + screen print
retro arcade look. No real slot machine brands, no existing characters.
```

- 推奨: 1536×640 前後の横長。ファイルは 300KB 以下に圧縮して配置（リポジトリ肥大防止）
- パネルは量子化パイプラインを通さない（1 枚絵は高解像度のままで良い）

## 3. リポジトリ運用

- 採用した生成物の**プロンプト・生成モデル名・日付をこのファイルに追記**する
  （曲のシード保存と同じ「再現手順ごとコミット」の思想）
- 生成元の原画（シート）はコミットしない。処理済み PNG（数 KB）のみ

## 個別生成の指示文（v2 以降で使用。シートより精細度が欲しいとき）

1 回の `codex exec` で 7 枚を連続生成させる。
**指示の先頭に「画像生成ツール必須・描画コード禁止」を明記すること** —
Codex は放っておくと GDI+ 等の描画スクリプトを書いて済ませることがある（v3 で実際に発生。
それはそれで再現性は完璧だが、画像生成の絵が欲しいときは明示的に縛る）:

```
IMPORTANT: You MUST produce every image with your built-in IMAGE GENERATION
tool (gpt-image). Do NOT write any drawing code or scripts (no System.Drawing,
no PowerShell, no Python/PIL, no SVG rendering).
```

共通スタイルプリアンブル:

```
Vintage Japanese pachislo reel symbol sticker, premium 1990s print quality:
thick white die-cut sticker border around the whole silhouette, bold black
keyline inside it, rich airbrushed cel shading with 3 tones per color,
glossy highlights, saturated festival colors, chunky rounded shapes.
WIDE LANDSCAPE COMPOSITION: the symbol is drawn wide and squat, stretched
horizontally to fill most of the frame WIDTH (about 2:1 width-to-height
proportions, like symbols printed on a real slot reel strip), centered on
a plain flat light gray background (hex d9d9d9), no drop shadow.
```

図柄ごとの主題（要点）: 7 = 「777 ジャックポットの 7。太い横バーの右端から左下へ斜め脚、
top bar の左端には何も付かない」 / BAR = 金縁の横長プレート / ベル = 裾が横に開いた squat な鐘 /
リプレイ = 閉じた楕円リングを成す 2 本の矢印カプセルバッジ / チェリー = 横並び 2 粒 /
スイカ = 平たいくし切り / ブランク = 横に広がるスマイル付きブロッコリー

## 重要: Codex 経由の「画像生成」の実態（2026-07-05 判明）

セッションログ（~/.codex/sessions）を精査した結果、**これまでコミットした全アセット
（v1 シート・単体 7・パネル 2 枚・v2・v3）は AI 画像生成ではなく、Codex が書いた
GDI+（System.Drawing）描画スクリプトの出力**だったことが判明した。
Codex の組み込み image_gen ツールは毎回実行されるが、この環境では出力ファイルが
`$CODEX_HOME/generated_images/` に永続化されず、Codex は黙ってスクリプト描画に
フォールバックしていた（v2 では「画像ツールで作った」と報告した上でスクリプトを
削除していたので注意。v1 の「T に見える 7」も生成ミスではなく矩形 2 本のコーディング産物）。

**本物の画像生成ファイルが欲しい場合**は、imagegen スキルの公式 CLI フォールバック
（`$CODEX_HOME/skills/.system/imagegen/scripts/image_gen.py`、gpt-image-2）を使う。
`OPENAI_API_KEY` が必要で、出力パスを明示できるため確実にファイル化できる。

## 手動生成用: コピペ用プロンプト 7 本

ChatGPT 等に 1 本ずつ貼って生成する（横長 1536×1024 推奨）。できた画像を
Claude Code のチャットに貼れば、パイプラインを通して差し替えてもらえる。

共通の様式（各プロンプトに含まれている）: 白縁ステッカー / 黒キーライン / セル影 3 段 /
ライトグレー背景（必須。白背景だと縁が処理で消える）/ 横長 2:1 構図

**1. 赤 7（seven_red）**
```
Vintage Japanese pachislo reel symbol sticker, premium 1990s print quality: thick white die-cut sticker border, bold black keyline, rich airbrushed cel shading with 3 tones, glossy highlights, saturated festival colors. WIDE LANDSCAPE COMPOSITION, the symbol wide and squat filling most of the frame width (about 2:1), centered on a plain flat light gray background (hex d9d9d9), no drop shadow. Subject: the numeral 7 in metallic red, extra bold and extra wide like the sevens of a 777 jackpot: a very thick horizontal top bar, and a thick diagonal leg starting at the RIGHT end of the top bar slanting down to the bottom left; nothing attached to the left end of the top bar. Small white star sparkle at top right.
```

**2. BAR（bar）**
```
Vintage Japanese pachislo reel symbol sticker, premium 1990s print quality: thick white die-cut sticker border, bold black keyline, rich airbrushed cel shading with 3 tones, glossy highlights. WIDE LANDSCAPE COMPOSITION, wide and squat filling most of the frame width (about 2:1), centered on a plain flat light gray background (hex d9d9d9), no drop shadow. Subject: a wide black rounded-rectangle BAR plate with beveled 3D edges, a gold trim frame, and bold white letters BAR stretched wide.
```

**3. ベル（bell）**
```
Vintage Japanese pachislo reel symbol sticker, premium 1990s print quality: thick white die-cut sticker border, bold black keyline, rich airbrushed cel shading with 3 tones, glossy highlights. WIDE LANDSCAPE COMPOSITION, wide and squat filling most of the frame width (about 2:1), centered on a plain flat light gray background (hex d9d9d9), no drop shadow. Subject: a squat wide golden bell with two-tone gold shading, a bright white glint, a small round red clapper at the bottom, and a small red ribbon bow on top; the bell mouth flares wide horizontally.
```

**4. リプレイ（replay）**
```
Vintage Japanese pachislo reel symbol sticker, premium 1990s print quality: thick white die-cut sticker border, bold black keyline, rich airbrushed cel shading with 3 tones, glossy highlights. WIDE LANDSCAPE COMPOSITION, wide and squat filling most of the frame width (about 2:1), centered on a plain flat light gray background (hex d9d9d9), no drop shadow. Subject: a wide blue enamel capsule badge: two thick curved blue arrows chasing each other forming one complete closed horizontal oval ring, each arrowhead touching the other arrow's tail, like a replay emblem.
```

**5. チェリー（cherry）**
```
Vintage Japanese pachislo reel symbol sticker, premium 1990s print quality: thick white die-cut sticker border, bold black keyline, rich airbrushed cel shading with 3 tones, glossy highlights. WIDE LANDSCAPE COMPOSITION, wide and squat filling most of the frame width (about 2:1), centered on a plain flat light gray background (hex d9d9d9), no drop shadow. Subject: two glossy red cherries side by side horizontally on short joined green stems with one green leaf, big round highlights.
```

**6. スイカ（melon）**
```
Vintage Japanese pachislo reel symbol sticker, premium 1990s print quality: thick white die-cut sticker border, bold black keyline, rich airbrushed cel shading with 3 tones, glossy highlights. WIDE LANDSCAPE COMPOSITION, wide and squat filling most of the frame width (about 2:1), centered on a plain flat light gray background (hex d9d9d9), no drop shadow. Subject: a wide watermelon slice lying flat with the long side horizontal, juicy red flesh with black seeds, striped light and dark green rind along the bottom.
```

**7. ブランク（blank・ブロッコリー）**
```
Vintage Japanese pachislo reel symbol sticker, premium 1990s print quality: thick white die-cut sticker border, bold black keyline, rich airbrushed cel shading with 3 tones, glossy highlights. WIDE LANDSCAPE COMPOSITION, wide and squat filling most of the frame width (about 2:1), centered on a plain flat light gray background (hex d9d9d9), no drop shadow. Subject: a cheerful cartoon broccoli drawn squat and wide with a tiny simple smiling face, two-tone green, florets spreading horizontally.
```

（任意）**筐体パネル**: 「DAREDEMO SLOT」ロゴの横長バナー。スペルは
D-A-R-E-D-E-M-O S-L-O-T と 1 文字ずつ明記すること（誤字対策）。

## 採用ログ

- **2026-07-04 図柄 7 種**: Codex CLI（組み込み画像ツール、gpt-image 系）で生成。
  シート（上記プロンプトそのまま）から bar/bell/replay/cherry/melon/blank の 6 種を採用。
  seven_red はシートの 7 が「T」に見えたため単体で再生成
  （プロンプトに「the diagonal must descend from the RIGHT end of the top bar, NOT the letter T」を追加）。
  全図柄 `npm run symbols` の既定パラメータで検証 OK
- **2026-07-04 筐体パネル**: 同上。1 回目はロゴが「DAREDEMQ」になったため、
  「spelled D-A-R-E-D-E-M-O (the last letter is the letter O, not Q)」を追加して再生成。
  `npm run panel -- panel2.png --width 560` で 331KB に縮小して配置

- **2026-07-05 図柄 v2（印刷シール調）**: フラット 16 色版が「悪い意味で 2 号機っぽい」との
  フィードバックを受けて様式を引き上げ。シート一括生成は 1 セル約 380px で精細度が頭打ち
  だったため、**7 図柄を 1 枚ずつ 1024px で個別生成**（1 回の codex exec で 7 枚連続生成）。
  スタイル整合は共通プリアンブル（白縁ステッカー + セル影 3 段 + ハイライト + グレー背景）
  + 量子化で担保。全図柄 128px・32 色検証 OK、1 発採用
- **2026-07-05 図柄 v3（実機準拠の横長・現行）**: 上記の個別生成指示を横長構図
  （wide & squat）に変えて Codex に依頼したところ、Codex は画像生成ツールではなく
  **GDI+（System.Drawing）の描画スクリプトを書いて実行**した（tools/draw-symbols-v3.ps1
  としてコミット済み。1536×1024 の 7 枚 + コンタクトシートを出力）。
  つまり v3 は AI 画像生成ではなく手続き描画で、指示文がスクリプトに「コンパイル」された形。
  再現性は完璧（スクリプト実行 → `npm run symbols` で同一アセットが再生成できる）。
  全図柄 160×100・32 色検証 OK

### 教訓

- 文字（7・ロゴ）は生成ミスの筆頭。**スペルを 1 文字ずつプロンプトに書く**と直る。
  7 は「the diagonal descends from the RIGHT end of the top bar」+「777 jackpot の 7」で安定
- **精細度が欲しいときはシートより個別生成**（セル解像度がボトルネック）。
  整合は共通スタイルプリアンブル + 量子化で取れる
- 白縁ステッカー様式では生成背景をライトグレーに（白背景だと背景除去が白縁を食う）
