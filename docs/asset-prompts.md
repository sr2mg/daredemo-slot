# 画像アセット生成プロンプト仕様

音を「OPLL という当時の制約ごと再現」したのと同じ発想で、絵にも様式制約を立てる。
目標様式は **90 年代パチスロの印刷図柄 / ドット絵**（少数色・太い輪郭・小サイズで判読可能）。
AI 生成のばらつきは後処理パイプライン（`npm run symbols`）が 16 色・64px に強制的に潰して均す。

## 権利ルール（音楽の PD 限定方針と同じ）

- プロンプトに**実在機種名・実在キャラクター・メーカー名を入れない**
- 「パチスロ風」「レトロスロット風」のような様式語は OK。特定作品の再現指示は NG

## 1. リール図柄シート

**1 プロンプト 1 枚で全図柄を同時生成する**（別々に生成するとスタイルがばらけるため）。
4×2 グリッドで 8 セル。生成後の切り出しはパイプラインが等分割で行うので、
「等間隔グリッド・各セル中央に 1 図柄・背景は無地白」が守られていることが重要。

### プロンプト（英語推奨。gpt-image 系向け）

```
Retro Japanese slot machine reel symbol sheet, 1990s pachislo style.
A strict 4x2 grid of 8 cells on a plain white background, each symbol centered
in its cell with generous margin, no grid lines, no text labels, no shadows.
Style: bold black outlines, flat vivid colors (max ~12 colors total),
screen-print / pixel-art hybrid look, high contrast, readable at small size.
Cells in order (left to right, top to bottom):
1. a bold red lucky number seven
2. a black rectangular BAR badge with white "BAR" letters
3. a golden bell
4. a blue circular replay arrows icon (two arrows forming a circle)
5. a pair of red cherries with a green stem
6. a watermelon slice
7. a single green broccoli (vegetable, used as a blank symbol)
8. empty cell (plain white)
No real slot machine brands, no existing characters, original design only.
```

- 推奨生成サイズ: 1536×1024 以上（横長）。数枚ガチャして一番揃っているものを採用
- 7 セル目のブロッコリーは純ブランクの伝統（獣王の木＝通称カリフラワー）へのオマージュ

### 後処理

```
npm run symbols -- sheet.png --grid 4x2 --names seven_red,bar,bell,replay,cherry,melon,blank,-
```

- `-` は捨てセル。出力は `src/ui/assets/symbols/<図柄ID>.png`（64px・16 色・透過）
- 図柄 ID はリール定義（machines/*.ts の strips）と一致させること:
  `seven_red / bar / bell / replay / cherry / melon / blank`
- 検証 NG（背景が残る・消えすぎ）が出たら `--tolerance` を上下（既定 90。背景残り → 120、消えすぎ → 60）
- 1 図柄だけ再生成したいとき: `npm run symbols -- one.png --name bell`

### 合格基準（パイプラインが機械検証）

- 16 色以内 / 不透明率 10〜98% / 正方形
- 目視: 3 コマ縦並び（実寸 64〜120px）で図柄が判別できる・輪郭が潰れていない

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

## 採用ログ

- **2026-07-04 図柄 7 種**: Codex CLI（組み込み画像ツール、gpt-image 系）で生成。
  シート（上記プロンプトそのまま）から bar/bell/replay/cherry/melon/blank の 6 種を採用。
  seven_red はシートの 7 が「T」に見えたため単体で再生成
  （プロンプトに「the diagonal must descend from the RIGHT end of the top bar, NOT the letter T」を追加）。
  全図柄 `npm run symbols` の既定パラメータで検証 OK
- **2026-07-04 筐体パネル**: 同上。1 回目はロゴが「DAREDEMQ」になったため、
  「spelled D-A-R-E-D-E-M-O (the last letter is the letter O, not Q)」を追加して再生成。
  `npm run panel -- panel2.png --width 560` で 331KB に縮小して配置

### 教訓

- 文字（7・ロゴ）は生成ミスの筆頭。**スペルを 1 文字ずつプロンプトに書く**と直る
- 図形図柄はシート一括で 1 発 OK。文字物だけ単体再生成の前提で回すと速い
