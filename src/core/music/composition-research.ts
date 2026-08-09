/**
 * 作曲エンジンの比較研究ログ。
 *
 * このファイルを仮説・実験結果の正本とし、Web UIも同じデータを表示する。
 * 新しい比較を始める前に仮説を追加し、終了後に status / assessment / experiments を更新する。
 * 将来のLLMは、局所ルールを追加する前にこの一覧を読み、既検証の論点と未検証の論点を確認すること。
 */

export type CompositionHypothesisStatus = 'tested' | 'partiallyTested' | 'untested';
export type CompositionExperimentStatus = 'completed' | 'running' | 'planned';

export interface CompositionExperiment {
  id: string;
  title: string;
  status: CompositionExperimentStatus;
  /** 実際に比較した問い。 */
  question: string;
  conditions: readonly string[];
  /** 手動ブラインド比較など、数値として残せる結果。 */
  result: string;
  conclusion: string;
  limitations: readonly string[];
}

export interface CompositionHypothesis {
  id: string;
  title: string;
  status: CompositionHypothesisStatus;
  /** A/B比較で反証可能な形にした仮説。 */
  proposition: string;
  /** 現時点の暫定判断。未検証なら、まだ判断できない旨を書く。 */
  assessment: string;
  experimentIds: readonly string[];
  nextComparison: string;
}

export const COMPOSITION_EXPERIMENTS: readonly CompositionExperiment[] = [
  {
    id: 'EXP-003',
    title: '警告削減と表現デバイス実装（聴かない層の介入）',
    status: 'completed',
    question: 'EXP-002で見つけた恒常警告と表現レンジの穴は、生成側の介入で塞げるか。',
    conditions: [
      'EXP-002と同一の168曲コーパスで、介入前後の警告数とプロファイルを比較',
    ],
    result: '警告: 旋律の非和声音328→0（正体は全件が同音連打の宙吊り。生成側で順次/和声音の受けに解決）、'
      + 'ベース279→22（74%はペダル低音の誤検知→診断をペダル認識に。ska五度はdim品質へ追従）。'
      + '表現: 最長音価1.84→3.5拍（保続142音）、休符始まり0→30曲、標準語法の装飾0→462音、'
      + 'ベロシティ下限0.58→0.53、レジスタ変位と署名跳躍（谷から踏み切り→9半音超→反行順次）を新設。',
    conclusion: '恒常警告の大半は少数の生成規則の欠落と診断の誤検知だった。表現デバイスは'
      + 'シンボリック検証（tests/music-expression.test.ts）で発火を保証。良し悪しは未聴取。',
    limitations: [
      '各デバイスの音楽的な効果（好み・情感）はブラインド比較で未検証。',
      '16分裏拍シンコペーションの穴は未着手のまま残っている。',
    ],
  },
  {
    id: 'EXP-002',
    title: '表現レンジ・頑健性の一括監査（聴かない層）',
    status: 'completed',
    question: 'エンジンは致命的な退化を起こすか。また、何を一度も表現しないか。',
    conditions: [
      '全進行 × 2調性 × スタイル/戦略/シード回転の40小節・168曲',
    ],
    result: '致命的異常（クラッシュ・検証エラー・旋律欠落・コピペ退化・声部交差・2小節超の沈黙）は0件。'
      + '一方で: 2拍以上のロングトーン0音 / 音域MIDI72-88固定 / 16分裏拍オンセット0.2% / '
      + '休符始まりの曲0/168 / 装飾音は標準語法で0（和風のみ発火）/ ベロシティ下限0.58。'
      + '恒常警告は旋律の非和声音進行312件・ベース経過音の未解決279件・跳躍超過101件。',
    conclusion: '「壊れている」系の問題は無い。名曲との差の候補は、表現レンジの穴'
      + '（ロングトーン・レジスタ・シンコペ・休符・装飾・弱音）と、生成と診断の恒常的乖離に絞られた。',
    limitations: [
      '標準語法・40小節・BPM150のみの計測。和風語法や他フォームは未計測。',
      '穴を塞ぐと良くなるかは未検証。プロファイルの変化は良し悪しの指標ではない。',
    ],
  },
  {
    id: 'EXP-001',
    title: '40小節の上位作曲戦略',
    status: 'completed',
    question: 'モチーフの不在と帰還、さらに全体を貫く中心命題は、通常構成より好まれるか。',
    conditions: [
      '条件1 通常構成',
      '条件2 不在と帰還',
      '条件3 中心命題',
    ],
    result: '9試行で、通常3・不在と帰還3・中心命題3。顕著な差は観測されなかった。',
    conclusion: '上位構成戦略だけでは、現段階の総合的な好みを大きく左右しない可能性がある。',
    limitations: [
      '9試行の探索的な自己評価であり、統計的に差がないと確定したわけではない。',
      '条件3はエネルギー弧だけでなく、和声・旋律の音域・編成も同時に変更している。',
      'ゲーム画面やプレイ体験の中では比較していない。',
    ],
  },
] as const;

export const COMPOSITION_HYPOTHESES: readonly CompositionHypothesis[] = [
  {
    id: 'HYP-001',
    title: 'モチーフの再登場時期',
    status: 'tested',
    proposition: 'Aの中心モチーフをB・Cで伏せてDまで帰還を遅らせると、通常構成より曲の魅力が上がる。',
    assessment: '多分、差は小さい。少なくとも今回の9試行では優位は見えなかった。',
    experimentIds: ['EXP-001'],
    nextComparison: 'いったん追加検証を止め、他の未検証仮説を優先する。必要なら試行数を増やして再確認する。',
  },
  {
    id: 'HYP-002',
    title: 'セクションのエネルギー弧',
    status: 'partiallyTested',
    proposition: 'Cを明確な谷、Dを一意な頂点にすると、通常のシード依存の起伏より曲の魅力が上がる。',
    assessment: '差は多分小さいが、まだ単独では検証できていない。条件3の複数変更に含まれていただけなので判断は弱い。',
    experimentIds: ['EXP-001'],
    nextComparison: 'モチーフ・和声・編成を固定し、エネルギー弧だけを通常／C谷D頂点で切り替える。',
  },
  {
    id: 'HYP-003',
    title: '最初のモチーフ固有性',
    status: 'untested',
    proposition: '最初の2小節に固有のリズムや特徴的な跳躍が一つあると、整っているだけのモチーフより記憶性と総合評価が上がる。',
    assessment: '未検証。条件1〜3は最初のモチーフを共有していたため、今回の比較では分からない。',
    experimentIds: [],
    nextComparison: 'コード・フォーム・編成を固定し、通常モチーフと「署名となるリズム／跳躍」を持つモチーフを比較する。',
  },
  {
    id: 'HYP-004',
    title: '声部進行とベースの独立性',
    status: 'untested',
    proposition: '旋律とベースが別方向へ進み、要所だけで合流する設計は、ルート中心の伴奏より奥行きと切なさを生む。',
    assessment: '未検証。現在の比較では各条件がほぼ同じ声部進行生成を使っている。'
      + 'EXP-002で、ベース経過音が根音へ解決しない警告が1.7件/曲と恒常的であることを確認。',
    experimentIds: ['EXP-002'],
    nextComparison: '同じ旋律とコードに対し、従来ベースと独立した対旋律的ベースだけを切り替える。',
  },
  {
    id: 'HYP-005',
    title: '一曲固有の例外',
    status: 'untested',
    proposition: '曲中に一度だけ現れる、規則から外れるが後から必然に聞こえる音程・拍・和音が、その曲固有の印象を強める。',
    assessment: '装置は実装済み（EXP-003の署名跳躍: 谷区間で一度だけの9半音超と反行の受け）。'
      + '発火はシンボリック検証済みだが、印象を強めるかは未聴取。',
    experimentIds: ['EXP-003'],
    nextComparison: '署名跳躍の入切だけを変えた同一シード曲でブラインド比較する。',
  },
  {
    id: 'HYP-006',
    title: '音色・アーティキュレーション',
    status: 'untested',
    proposition: '音価、休符、音色変化、発音の強弱をモチーフと連動させると、音高とリズムだけの変奏より印象が強くなる。',
    assessment: '未検証。条件1〜3は音色と発音設計を共有している。'
      + 'EXP-002で、装飾が標準語法で休眠・ベロシティ下限0.58・16分裏拍ほぼ皆無であることを確認。'
      + 'EXP-003で標準語法の装飾・谷区間の低ダイナミクスを実装（裏拍シンコペは未着手）。',
    experimentIds: ['EXP-002', 'EXP-003'],
    nextComparison: 'ノート列を固定し、均一な発音とモチーフ連動の発音・音色変化を比較する。',
  },
  {
    id: 'HYP-007',
    title: 'ループ境界の予告と回収',
    status: 'untested',
    proposition: '終端で冒頭のリズム・音・和声を予告すると、単純に終止して戻るよりループを繰り返し聴きやすい。',
    assessment: '未検証。構造診断はあるが、ループの聴感を独立した好みとして比較していない。',
    experimentIds: [],
    nextComparison: '同じ曲の終端だけを、通常終止／冒頭予告付きにして複数周聴取で比較する。',
  },
  {
    id: 'HYP-009',
    title: 'ロングトーンと和声変化の重なり',
    status: 'untested',
    proposition: '2拍以上伸ばした旋律音の下で和声が変わる瞬間は、細かい音の連続より「せつなさ」系の情感を生む。',
    assessment: '装置は実装済み（EXP-003: 終止到達音を次小節の最初の発音まで保続、最長3.5拍）。'
      + '発火はシンボリック検証済みだが、情感を生むかは未聴取。',
    experimentIds: ['EXP-002', 'EXP-003'],
    nextComparison: 'ロングトーン装置の入切だけを変えた同一シード曲でブラインド比較し、情感の標的質問も併用する。',
  },
  {
    id: 'HYP-008',
    title: 'ゲーム体験との結合',
    status: 'untested',
    proposition: '音楽単体では同程度でも、場面の速度・緊張・転換と曲の構造が同期するとゲーム音楽としての評価が上がる。',
    assessment: '未検証。これまでの投票は音楽単体で行っている。',
    experimentIds: [],
    nextComparison: '同じ短いゲーム場面へ候補曲をランダムに組み込み、適合感・邪魔にならなさ・再記憶を比較する。',
  },
  {
    id: 'HYP-010',
    title: '五音語彙×カラートーン和声の共存',
    status: 'untested',
    proposition: 'kmmo系の曲で旋律語法をpentatonic(無半音五音、装置は生かす)にすると、'
      + 'standard(ダイアトニック)より00年代ネトゲBGM系の様式適合と魅力が上がる。'
      + '根拠は四千年の実測(旋律pc上位5音=メジャーペンタで54%、和声はM7 41%のカラートーン飽和、'
      + '跳躍は五音隣接2/3半音セル上行が最頻で彩りにP4/P5)。',
    assessment: '装置は実装済み(melodicLanguage: pentatonic。五音は文化様式でなく音組織として分離し、'
      + 'テンション・ディミニューション・デュエット・グライドは通常どおり)。様式適合・魅力は未聴取。',
    experimentIds: [],
    nextComparison: '同一シード・同一kmmoオプションで melodicLanguage standard/pentatonic だけを切り替えてブラインド比較する。',
  },
  {
    id: 'HYP-011',
    title: '走句による16分細分密度',
    status: 'untested',
    proposition: 'ストレート・中庸BPMのrich細分で4分対を16分走句(到達側へ寄せた音組織の歩み)で埋めると、'
      + '8分対の経過音のみより疾走感が上がり、かつ機械的にならない。'
      + '根拠はESTi系実測(BPM96-103でonsets/beat 2.74、旋律の65%が16分、16分裏拍率0.35)。'
      + 'EXP-002/003で残っていた「16分裏拍シンコペーションの穴」への回答でもある。',
    assessment: '装置は実装済み(diminution.tsのフィギュア一般化: 経過音・走句・刺繍音。'
      + '走句はストレートのみ、副旋律の予約対は譲る、装飾は骨格の音域を広げない)。疾走感の効果は未聴取。',
    experimentIds: [],
    nextComparison: '同一シードで走句の入切(maxGapBeats 0.75/1.0)だけを変えてブラインド比較する。',
  },
  {
    id: 'HYP-012',
    title: '曲間モチーフ流用',
    status: 'untested',
    proposition: '同一モチーフ(実音でなくジェスチャー)を別のキー・語法・スタイルで再実現した2曲は、'
      + '無関係な2曲より「同じ作品世界の曲」として認知され、セットとしての印象が上がる。'
      + '根拠はESTiのモチーフ運用(Apparition主題のOP・四千年・MOTIVITYへの語法横断流用)。',
    assessment: '装置は実装済み(Piece.motifの保存とComposeOptions.externalMotifによる移植。'
      + 'モチーフは往復不変・決定論)。認知効果は未聴取。',
    experimentIds: [],
    nextComparison: 'externalMotifを共有した2曲ペアと独立シードの2曲ペアを聴かせ、「同じ世界の曲はどちらか」を当てさせる。',
  },
  {
    id: 'HYP-013',
    title: '実音テーマとリテラル反復',
    status: 'untested',
    proposition: 'モチーフを抽象ジェスチャーでなく実音の音度列(melodic-theme.ts)として固定し、'
      + '提示→変奏反復をリテラル反復(平行ピリオド)、Dをフックのリテラル帰還にすると、'
      + '毎音を和声へ吸着し直す従来方式より記憶性と総合評価が上がる。'
      + '根拠はMargulisの反復研究(リテラル反復が記憶の主エンジン)とHYP-003の未検証論点。',
    assessment: '装置は実装済み(区間ごとの音度列テーマ・アンカーのみ和声調整・literal変形・'
      + 'フック反復下限の診断)。HYP-003はこの装置でようやく検証可能になった。効果は未聴取。'
      + 'シンボリック実測: 提示vs変奏反復の実音一致は旧21.8%→68.4%、40小節Dの帰還は92.8%一致。'
      + '差分の主因は別和音下の強拍調整(変応)と、対の片側だけに当たる表現デバイス。'
      + 'なお和風語法も核音保持イディオムからテーマウォークへ置換されており(同音連続率31.8%→26.8%)、'
      + 'これは未聴取の様式変更としてブラインド比較の対象に含めること。',
    experimentIds: [],
    nextComparison: '同一シードで実音テーマ方式と旧ジェスチャー方式(コミット差分)をブラインド比較する。',
  },
  {
    id: 'HYP-014',
    title: 'ゼクエンツによる展開',
    status: 'untested',
    proposition: '展開(departure)をテーマ末尾断片の2度ずつの反復進行(センテンス構文の断片化→'
      + 'リキダーション)にすると、方向反転の再ウォークより「意味のある展開」として聴こえる。',
    assessment: '装置は実装済み(fragmentOf+度数ランプ。強拍は既存規則で和声へ量子化)。効果は未聴取。',
    experimentIds: [],
    nextComparison: '同一シードでゼクエンツの入切だけを変えてブラインド比較する。',
  },
  {
    id: 'HYP-015',
    title: '強拍倚音',
    status: 'untested',
    proposition: '強拍のテーマ音が非和声のとき、2度で解決できる場合に限り倚音として保持すると、'
      + '常に和声音へ吸着するより「切なさ」系の情感と表現の幅が上がる。'
      + '頻度はスタイルの順次進行率から導出し、上限25%。',
    assessment: '装置は実装済み(計画小節×条件判定。診断は1拍以内の順次解決を免責)。効果は未聴取。',
    experimentIds: [],
    nextComparison: '同一シードで倚音の入切だけを変え、情感の標的質問付きでブラインド比較する。',
  },
  {
    id: 'HYP-016',
    title: '終止音度の物語と弱起',
    status: 'untested',
    proposition: 'フレーズ終止を3̂→(5̂|2̂)→2̂→1̂と計画し(cadenceDegrees)、答句末尾へ次フレーズ頭の'
      + '2度下の弱起を置くと、毎回ルート終止・毎小節頭拍開始よりフレーズの方向性と呼吸が生まれる。',
    assessment: '装置は実装済み(SongSectionPlan.cadenceDegrees / PhraseBarPlan.anacrusis)。効果は未聴取。',
    experimentIds: [],
    nextComparison: '終止音度固定(全てルート)と物語あり、弱起の入切を独立に切り替えて比較する。',
  },
] as const;

export const COMPOSITION_HYPOTHESIS_STATUS_LABELS: Record<CompositionHypothesisStatus, string> = {
  tested: '検証済み',
  partiallyTested: '一部検証',
  untested: '未検証',
};

export const COMPOSITION_EXPERIMENT_STATUS_LABELS: Record<CompositionExperimentStatus, string> = {
  completed: '完了',
  running: '検証中',
  planned: '予定',
};

export function compositionExperiment(id: string): CompositionExperiment | undefined {
  return COMPOSITION_EXPERIMENTS.find((experiment) => experiment.id === id);
}
