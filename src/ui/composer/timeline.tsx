/**
 * 曲のタイムライン: 上から小節目盛り・区間(アレンジャー)・コード・パート別レーン。
 * 曲型の編集・コード選択・結果の表示・診断の指摘位置を、この 1 枚の時間軸へ重ねる。
 * レーンは読み取り専用のピアノロールで、音符の手編集はしない(生成結果を見る・聴くための表示)。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { arrangePiece } from '../../audio/opll-arrange.js';
import { slotAtBar } from '../../core/music/harmony-plan.js';
import { capabilitiesFor } from '../../core/music/sound-capabilities.js';
import { KEYS, chordName } from '../../core/music/theory.js';
import {
  BAR_BEATS, ROLE_COLORS, ROLE_LABELS, formatBarBeat, nesChannelLanes, opllChannelLanes, scoreLanes,
} from './piece-view.js';
import type { Lane, SectionBlock } from './piece-view.js';
import type { Composer } from './use-composer.js';

export type TimelineView = 'score' | 'channels';

/** レーン見出し列の幅(px)。横スクロールしても左へ貼り付く。 */
const HEAD_W = 124;
const LANE_HEIGHT = { pitch: 58, drums: 44 } as const;
/** これより狭い小節幅では、コード名・小節番号を間引く。 */
const CHORD_TEXT_MIN_PX = 44;

const keyLabel = (root: number): string => KEYS.find((key) => key.root === ((root % 12) + 12) % 12)?.label ?? '?';

/** 1 レーンぶんの音符を canvas へ描く。曲が変わったときだけ描き直す。 */
function LaneCanvas({ lane, totalBeats, pxPerBar, height, boundaries, dimmed }: {
  lane: Lane;
  totalBeats: number;
  pxPerBar: number;
  height: number;
  /** 区間の境界(拍)。小節線より強い線で引く。 */
  boundaries: readonly number[];
  dimmed: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const width = Math.max(1, Math.round((totalBeats / BAR_BEATS) * pxPerBar));

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // 長い曲を拡大しても canvas の実ピクセル幅がブラウザの上限を超えないよう、倍率を抑える。
    const scale = Math.max(0.5, Math.min(window.devicePixelRatio || 1, 16000 / width));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const xOf = (beat: number): number => (beat / BAR_BEATS) * pxPerBar;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let bar = 1; bar * BAR_BEATS < totalBeats; bar++) ctx.fillRect(Math.round(xOf(bar * BAR_BEATS)), 0, 1, height);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (const beat of boundaries) ctx.fillRect(Math.round(xOf(beat)), 0, 1, height);

    const rows = lane.hi - lane.lo + 1;
    const rowHeight = (height - 6) / rows;
    const noteHeight = Math.max(2, Math.min(lane.kind === 'drums' ? 6 : 7, rowHeight));
    ctx.globalAlpha = dimmed ? 0.25 : 1;
    for (const note of lane.notes) {
      const x = xOf(note.beat);
      const w = Math.max(2, xOf(note.dur) - 1);
      const y = 3 + (lane.hi - note.row) * rowHeight + (rowHeight - noteHeight) / 2;
      if (note.dropped) {
        ctx.strokeStyle = '#ff6f6f';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, noteHeight - 1));
      } else {
        ctx.fillStyle = note.color ?? lane.color;
        ctx.fillRect(x, y, w, noteHeight);
      }
    }
    ctx.globalAlpha = 1;
  }, [lane, totalBeats, pxPerBar, height, width, boundaries, dimmed]);

  return <canvas ref={ref} className="tl-canvas" style={{ width, height }} />;
}

/** 再生ヘッド。再生中は自前のタイマーで位置を引き、タイムライン全体を再描画させない。 */
function Playhead({ getBeat, cursorBeat, playing, pxPerBar, scrollRef }: {
  getBeat: () => number | null;
  cursorBeat: number;
  playing: boolean;
  pxPerBar: number;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const place = (): void => {
      const element = ref.current;
      if (!element) return;
      const beat = (playing ? getBeat() : null) ?? cursorBeat;
      const x = HEAD_W + (beat / BAR_BEATS) * pxPerBar;
      element.style.transform = `translateX(${x}px)`;
      const scroller = scrollRef.current;
      if (!playing || !scroller) return;
      // 再生ヘッドが見えている範囲を出たら、ヘッドが左端近くへ来るように送る。
      const left = scroller.scrollLeft + HEAD_W;
      const right = scroller.scrollLeft + scroller.clientWidth - 24;
      if (x < left || x > right) scroller.scrollLeft = Math.max(0, x - HEAD_W - 24);
    };
    place();
    if (!playing) return undefined;
    // rAF は非表示タブで止まるので、タイマーで引く(40ms ≒ 25fps で十分滑らか)。
    const timer = setInterval(place, 40);
    return () => clearInterval(timer);
  }, [getBeat, cursorBeat, playing, pxPerBar, scrollRef]);
  return <div ref={ref} className={`tl-playhead${playing ? ' playing' : ''}`} data-testid="tl-playhead" />;
}

export function Timeline({ composer, view, zoom }: {
  composer: Composer;
  view: TimelineView;
  /** 1 小節の幅(px)。'fit' は表示幅に曲全体を収める(俯瞰。コード名は拡大すると出る)。 */
  zoom: number | 'fit';
}) {
  const { piece, blocks, form, formSpec, prog, readOnly, viewOptions } = composer;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(900);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const measure = (): void => setViewportWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const totalBeats = piece?.beats ?? BAR_BEATS * 4;
  const totalBars = totalBeats / BAR_BEATS;
  const pxPerBar = zoom === 'fit'
    ? Math.max(6, Math.min(160, Math.floor((viewportWidth - HEAD_W - 2) / totalBars)))
    : zoom;
  const contentWidth = Math.round(totalBars * pxPerBar);
  const boundaries = useMemo(() => blocks.slice(1).map((block) => block.startBeat), [blocks]);

  const chip = viewOptions?.soundChip ?? 'opll';
  const lanes = useMemo((): Lane[] => {
    if (!piece || !viewOptions) return [];
    if (view === 'score') return scoreLanes(piece);
    if (chip === 'nes2a03') return nesChannelLanes(piece);
    if (chip === 'pcm') return [];
    return opllChannelLanes(
      arrangePiece(piece, viewOptions.styleId, viewOptions.voices, viewOptions.opllUserPatch).channelNotes,
    );
  }, [piece, viewOptions, view, chip]);
  const droppedCount = view === 'channels' ? lanes.find((lane) => lane.id === 'dropped')?.notes.length ?? 0 : 0;

  if (!piece) {
    return (
      <div className="tl tl-empty" data-testid="tl">
        <p className="badge-ng">{composer.composeError || '曲を組めません'}</p>
        <p className="panel-note">右のインスペクタで設定を直すと、ここに曲が表示されます。</p>
      </div>
    );
  }

  const seekFromEvent = (event: ReactMouseEvent<HTMLElement>): void => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const x = event.clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft - HEAD_W;
    if (x < 0) return;
    const bar = Math.max(0, Math.min(totalBars - 1, Math.floor(x / pxPerBar)));
    composer.seek(bar * BAR_BEATS);
  };

  const selectBlock = (block: SectionBlock): void => {
    composer.setSelectedSection(block.isIntro ? null : block.id);
    composer.seek(block.startBeat);
  };

  const introBars = piece.loopStartBeat / BAR_BEATS;
  const barStep = pxPerBar >= 30 ? 1 : pxPerBar >= 16 ? 2 : 4;
  const rowStyle: CSSProperties = { width: HEAD_W + contentWidth };
  const issueBeats = composer.diagnosisItems.map((item) => item.issue);
  const mutedNow = (lane: Lane): boolean => (
    lane.role !== null && (composer.solo !== null ? composer.solo !== lane.role : composer.muted.includes(lane.role))
  );

  return (
    <div className="tl" data-testid="tl">
      <div className="tl-scroll" ref={scrollRef}>
        {/* 小節目盛り: クリックでその小節へ移動。診断の指摘は該当位置に印を出す */}
        <div className="tl-row tl-ruler-row" style={rowStyle}>
          <div className="tl-head tl-head-quiet">小節</div>
          <div className="tl-track tl-ruler" style={{ width: contentWidth }} onClick={seekFromEvent} data-testid="tl-ruler">
            {Array.from({ length: Math.ceil(totalBars) }, (_, bar) => bar).filter((bar) => bar % barStep === 0).map((bar) => (
              <span key={bar} className="tl-bar-number" style={{ left: bar * pxPerBar }}>{bar + 1}</span>
            ))}
            {issueBeats.map((issue, index) => (
              <span
                key={index}
                className={`tl-issue tl-issue-${issue.severity}`}
                style={{ left: (issue.beat / BAR_BEATS) * pxPerBar }}
                title={`${formatBarBeat(issue.beat)}: ${issue.reason}`}
              >
                ▾
              </span>
            ))}
          </div>
        </div>

        {/* 区間(アレンジャー): クリックで区間を選び、インスペクタがその区間へ切り替わる */}
        <div className="tl-row" style={rowStyle}>
          <div className="tl-head">区間</div>
          <div className="tl-track tl-sections" style={{ width: contentWidth }}>
            {blocks.map((block) => {
              const selected = !block.isIntro && composer.selectedSection === block.id;
              const reseeded = !block.isIntro && form.sectionSeeds[block.id] !== undefined && !readOnly;
              return (
                <button
                  key={block.id}
                  type="button"
                  className={`tl-section${selected ? ' selected' : ''}${block.isIntro ? ' intro' : ''}`}
                  style={{ left: (block.startBeat / BAR_BEATS) * pxPerBar, width: block.bars * pxPerBar }}
                  onClick={() => selectBlock(block)}
                  title={`${block.isIntro ? 'イントロ' : `区間 ${block.id}`} — ${block.roleLabel}・${block.bars}小節`
                    + `${block.energy !== null ? `・力 ${block.energy}` : ''}・キー ${keyLabel(block.keyRoot)}`}
                  data-testid={`tl-section-${block.id}`}
                >
                  {block.energy !== null && (
                    <span className="tl-section-energy" style={{ height: `${block.energy * 20}%` }} />
                  )}
                  <span className="tl-section-name">
                    {block.isIntro ? 'Intro' : block.id}{reseeded ? ' 🎲' : ''}
                  </span>
                  <span className="tl-section-role">
                    {block.roleLabel}
                    {block.keyRoot !== piece.keyRoot ? ` · ${keyLabel(block.keyRoot)}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* コード: 選択肢のある小節はその場で選べる(編集した小節は自動のコード変化から外れる) */}
        <div className="tl-row" style={rowStyle}>
          <div className="tl-head">コード</div>
          <div className="tl-track tl-chords" style={{ width: contentWidth }}>
            {Array.from({ length: Math.round(totalBars) }, (_, absoluteBar) => {
              const bar = absoluteBar - introBars;
              const name = bar < 0 ? piece.introChordNames[absoluteBar] ?? '' : piece.barChordNames[bar] ?? '';
              const cellStyle: CSSProperties = { left: absoluteBar * pxPerBar, width: pxPerBar };
              const block = blocks.find((candidate) => (
                absoluteBar * BAR_BEATS >= candidate.startBeat && absoluteBar * BAR_BEATS < candidate.endBeat
              ));
              const slot = bar >= 0 && !readOnly && bar < composer.formBars ? slotAtBar(prog, form.form, bar) : null;
              if (slot && slot.length > 1 && pxPerBar >= CHORD_TEXT_MIN_PX && block) {
                return (
                  <select
                    key={absoluteBar}
                    className="tl-chord tl-chord-choice"
                    style={cellStyle}
                    value={Math.min(form.choice[bar] ?? 0, slot.length - 1)}
                    onChange={(event) => composer.setChordChoice(bar, Number(event.target.value))}
                    title={`${absoluteBar + 1}小節のコードを選ぶ`}
                    data-testid={`tl-chord-${bar}`}
                  >
                    {slot.map((option, index) => (
                      <option key={index} value={index}>
                        {option.map((token) => chordName(token, block.keyRoot)).join(' ')}
                      </option>
                    ))}
                  </select>
                );
              }
              return (
                <span key={absoluteBar} className="tl-chord" style={cellStyle} title={`${absoluteBar + 1}小節: ${name}`}>
                  {pxPerBar >= CHORD_TEXT_MIN_PX ? name : ''}
                </span>
              );
            })}
          </div>
        </div>

        {view === 'channels' && chip === 'pcm' && (
          <div className="tl-row" style={rowStyle}>
            <div className="tl-head tl-head-quiet">チャンネル</div>
            <div className="tl-track tl-note" style={{ width: contentWidth }}>
              PCM（SoundFont）は声部数の制約が無いため、チャンネルの割り当てはありません。譜面表示で確認できます。
            </div>
          </div>
        )}

        {lanes.map((lane) => {
          const height = LANE_HEIGHT[lane.kind];
          const dimmed = mutedNow(lane);
          return (
            <div key={lane.id} className="tl-row tl-lane-row" style={rowStyle}>
              <div className={`tl-head tl-lane-head${dimmed ? ' dimmed' : ''}`} style={{ height }}>
                <span className="tl-lane-swatch" style={{ background: lane.role ? ROLE_COLORS[lane.role] : lane.color }} />
                <span className="tl-lane-label">{lane.label}</span>
                {lane.role !== null && (
                  <span className="tl-lane-buttons">
                    <button
                      type="button"
                      className={`tl-ms${composer.muted.includes(lane.role) ? ' on-mute' : ''}`}
                      onClick={() => composer.toggleMute(lane.role!)}
                      title={`${ROLE_LABELS[lane.role]}をミュート`}
                      aria-pressed={composer.muted.includes(lane.role)}
                      data-testid={`tl-mute-${lane.role}`}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      className={`tl-ms${composer.solo === lane.role ? ' on-solo' : ''}`}
                      onClick={() => composer.toggleSolo(lane.role!)}
                      title={`${ROLE_LABELS[lane.role]}だけを聴く`}
                      aria-pressed={composer.solo === lane.role}
                      data-testid={`tl-solo-${lane.role}`}
                    >
                      S
                    </button>
                  </span>
                )}
              </div>
              <div className="tl-track tl-lane" style={{ width: contentWidth, height }} onClick={seekFromEvent}>
                <LaneCanvas
                  lane={lane}
                  totalBeats={totalBeats}
                  pxPerBar={pxPerBar}
                  height={height}
                  boundaries={boundaries}
                  dimmed={dimmed}
                />
              </div>
            </div>
          );
        })}

        <Playhead
          getBeat={composer.positionBeat}
          cursorBeat={composer.cursorBeat}
          playing={composer.playing}
          pxPerBar={pxPerBar}
          scrollRef={scrollRef}
        />
      </div>

      {view === 'channels' && chip !== 'pcm' && (
        <p className="panel-note tl-legend" data-testid="tl-channel-legend">
          {capabilitiesFor(chip).label} の実際の割り当て。色は役割:
          {(['lead', 'duet', 'counter', 'ostinato', 'backing', 'bass', 'drums'] as const).map((role) => (
            <span key={role} className="tl-legend-item">
              <span className="tl-lane-swatch" style={{ background: ROLE_COLORS[role] }} />{ROLE_LABELS[role]}
            </span>
          ))}
          {chip === 'opll' && (
            droppedCount > 0
              ? <span className="tl-legend-dropped">声部不足で落ちた音: {droppedCount}（赤枠）</span>
              : <span>落ちた音はありません</span>
          )}
        </p>
      )}
    </div>
  );
}
