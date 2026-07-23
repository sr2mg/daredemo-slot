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
