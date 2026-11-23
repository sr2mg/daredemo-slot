/**
 * ラボ: 作曲戦略の 3 条件ブラインド比較と、作曲仮説の検証履歴。
 * 曲を作る動線(作曲タブ)からは外し、エンジンを評価するときだけ開く。
 */

import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { compose } from '../../core/music/compose.js';
import {
  BLIND_STUDY_FORM, createBlindStudyTrial, createBlindStudyVote, isBlindStudyVote, mergeBlindStudyVotes,
  parseBlindStudyVotes, serializeBlindStudyVotes, summarizeBlindStudyVotes,
} from '../../core/music/blind-study.js';
import type { BlindCandidateId, BlindStudyTrial, BlindStudyVote } from '../../core/music/blind-study.js';
import { COMPOSITION_STRATEGIES, compositionStrategyInfo } from '../../core/music/composition-strategy.js';
import { variedChoiceFor } from '../../core/music/harmony-plan.js';
import { diffPieceSections, PIECE_PART_LABELS, pieceSectionLabel } from '../../core/music/piece-diff.js';
import type { PiecePartId } from '../../core/music/piece-diff.js';
import { bgmCacheKey, renderComposedBgm } from '../../audio/render.js';
import { CompositionResearchPanel } from '../composition-research-panel.js';
import { newSeed, optionsOfForm } from '../composer-form.js';
import { loadStored, saveStored } from '../persist.js';
import type { Composer } from './use-composer.js';

const BLIND_VOTES_KEY = 'daredemo.bgmComposer.blindStudy.v1';

function loadBlindStudyVotes(): BlindStudyVote[] {
  return loadStored<BlindStudyVote[]>(
    BLIND_VOTES_KEY,
    [],
    (value): value is BlindStudyVote[] => Array.isArray(value) && value.every(isBlindStudyVote),
  );
}

export function LabPanel({ composer }: { composer: Composer }) {
  const { player, pcmRenderer, pcmVoices, form, prog, progress, setProgress, setError } = composer;
  const [trial, setTrial] = useState<BlindStudyTrial | null>(null);
  const [listened, setListened] = useState<BlindCandidateId[]>([]);
  const [selection, setSelection] = useState<BlindCandidateId | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<BlindCandidateId | null>(null);
  const [votes, setVotes] = useState<BlindStudyVote[]>(loadBlindStudyVotes);
  const voteSummary = useMemo(() => summarizeBlindStudyVotes(votes), [votes]);
  const votesFileRef = useRef<HTMLInputElement | null>(null);
  const busy = progress !== null;

  /** 候補間で音イベントが異なる区間。曲頭から全部聴かなくても差分だけ確認できるようにする。 */
  const diff = useMemo(() => {
    if (!trial) return null;
    try {
      const pieces = trial.candidates.map((candidate) => compose(candidate.options));
      const differing = diffPieceSections(pieces).filter((section) => section.differingParts.length > 0);
      const parts = [...new Set(differing.flatMap((section) => section.differingParts))] as PiecePartId[];
      return {
        bpm: pieces[0]!.bpm,
        differing,
        parts,
        range: differing.length === 0
          ? null
          : { startBeat: differing[0]!.startBeat, endBeat: differing[differing.length - 1]!.endBeat },
      };
    } catch {
      return null;
    }
  }, [trial]);

  const stop = (): void => {
    composer.stop();
    setNowPlaying(null);
  };

  const start = (): void => {
    try {
      stop();
      const seed = newSeed();
      const choice = variedChoiceFor(prog, BLIND_STUDY_FORM, seed);
      const baseOptions = optionsOfForm(form, pcmVoices, { seed, form: BLIND_STUDY_FORM, choice });
      const next = createBlindStudyTrial(`t${Date.now().toString(36)}${seed.toString(36)}`, baseOptions, seed ^ 0x424c_494e);
      // 音声レンダリング前に3条件とも構成可能か検証し、途中で一候補だけ失敗する状態を防ぐ。
      next.candidates.forEach((candidate) => compose(candidate.options));
      setTrial(next);
      setListened([]);
      setSelection(null);
      setRevealed(false);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const playCandidate = async (
    candidateId: BlindCandidateId,
    segment?: { startAtSec: number; stopAfterSec: number },
  ): Promise<void> => {
    const candidate = trial?.candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    try {
      setError(player.enabled ? '' : '「音」が OFF のため比較試聴できません（画面上部で ON にできます）');
      if (!player.enabled) return;
      stop();
      const key = bgmCacheKey(candidate.options, pcmRenderer);
      const def = player.getCachedPcmBgm(key)
        ?? await renderComposedBgm(compose(candidate.options), candidate.options, pcmRenderer);
      setProgress(0);
      const result = await player.playComposedBgm(key, def, 0, { loop: false, onProgress: setProgress, ...(segment ?? {}) });
      setProgress(null);
      if (result !== 'played') return;
      setNowPlaying(candidateId);
      // 差分区間だけの試聴は「3候補を聴いた」に数えない。投票は必ず全体を聴いてから。
      if (!segment) setListened((list) => (list.includes(candidateId) ? list : [...list, candidateId]));
    } catch (e) {
      setProgress(null);
      setNowPlaying(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const playDiff = (candidateId: BlindCandidateId): void => {
    if (!diff?.range) return;
    const secPerBeat = 60 / diff.bpm;
    void playCandidate(candidateId, {
      startAtSec: diff.range.startBeat * secPerBeat,
      // 差分の最終区間の直後で止める。+1秒は最後の音の余韻ぶん。
      stopAfterSec: (diff.range.endBeat - diff.range.startBeat) * secPerBeat + 1,
    });
  };

  const reveal = (): void => {
    if (!trial || !selection || listened.length < 3 || revealed) return;
    const selected = trial.candidates.find((candidate) => candidate.id === selection);
    if (!selected) return;
    stop();
    const next = [...votes, createBlindStudyVote(trial, selected.strategy, Date.now())];
    setVotes(next);
    saveStored(BLIND_VOTES_KEY, next);
    setRevealed(true);
  };

  /** 票はブラウザのlocalStorageにしか無いため、ファイルへ書き出して恒久保存する。 */
  const exportVotes = (): void => {
    const url = URL.createObjectURL(new Blob([serializeBlindStudyVotes(votes, Date.now())], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `blind-votes-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importVotes = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const merged = mergeBlindStudyVotes(votes, parseBlindStudyVotes(await file.text()));
      setVotes(merged);
      saveStored(BLIND_VOTES_KEY, merged);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="ws-page">
      <section className="blind-study" data-testid="blind-study">
        <div className="blind-study-head">
          <div>
            <h3>3条件ブラインド比較</h3>
            <p>
              作曲タブの現在の進行・様式・キー・BPM・音色から40小節を生成します。
              3候補はシードと進行語彙を共有し、フォーム・和声・旋律・編成を導く作曲戦略だけが異なります。
            </p>
          </div>
          <button type="button" onClick={start} disabled={busy} data-testid="blind-start">
            {trial ? '↻ 新しい比較を作る' : '⚗ 比較を作る'}
          </button>
        </div>

        {trial ? (
          <>
            <div className="blind-candidates">
              {trial.candidates.map((candidate) => {
                const heard = listened.includes(candidate.id);
                const selected = selection === candidate.id;
                const strategy = compositionStrategyInfo(candidate.strategy);
                return (
                  <article
                    key={candidate.id}
                    className={`blind-candidate${selected ? ' selected' : ''}${nowPlaying === candidate.id ? ' playing' : ''}`}
                    data-testid={`blind-candidate-${candidate.id}`}
                  >
                    <div className="blind-candidate-title">
                      <span>候補</span>
                      <strong>{candidate.id}</strong>
                      <small>{heard ? '試聴済み' : '未試聴'}</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => void playCandidate(candidate.id)}
                      disabled={busy}
                      data-testid={`blind-play-${candidate.id}`}
                    >
                      {nowPlaying === candidate.id ? '▶ 再生中' : heard ? '▶ もう一度聴く' : '▶ 試聴する'}
                    </button>
                    <button
                      type="button"
                      onClick={() => playDiff(candidate.id)}
                      disabled={busy || !diff?.range}
                      data-testid={`blind-play-diff-${candidate.id}`}
                      title="候補間で音が異なる区間だけを聴きます（「試聴済み」には数えません）"
                    >
                      ▶ 差分だけ
                    </button>
                    <label className="blind-pick">
                      <input
                        type="radio"
                        name="blind-favorite"
                        value={candidate.id}
                        checked={selected}
                        disabled={revealed}
                        onChange={() => setSelection(candidate.id)}
                        data-testid={`blind-pick-${candidate.id}`}
                      />
                      これが一番よい
                    </label>
                    {revealed && (
                      <div className="blind-reveal" data-testid={`blind-reveal-${candidate.id}`}>
                        <b>条件{strategy.condition}: {strategy.label}</b>
                        <span>{strategy.description}</span>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            {diff && (
              <p className="blind-diff-note" data-testid="blind-diff-note">
                {diff.range
                  ? `候補間の差分区間: ${diff.differing.map((section) => pieceSectionLabel(section.section)).join('・')}`
                    + `（${diff.parts.map((part) => PIECE_PART_LABELS[part]).join('・')}が異なる）`
                  : '3候補の音イベントは完全に同一です（好みの差は出ません）'}
              </p>
            )}

            <div className="blind-study-actions">
              <button
                type="button"
                onClick={reveal}
                disabled={revealed || listened.length < 3 || selection === null || busy}
                data-testid="blind-reveal"
              >
                結果を見る
              </button>
              <button type="button" onClick={stop} disabled={nowPlaying === null}>
                ■ 停止
              </button>
              {!revealed && (
                <span className="blind-progress-copy">
                  {listened.length}/3 試聴済み
                  {listened.length === 3 && selection === null ? ' — 一番よい候補を選んでください' : ''}
                </span>
              )}
            </div>

            {revealed && selection && (
              <div className="blind-result" data-testid="blind-result">
                <p>
                  今回選んだのは <strong>候補{selection}</strong> — {' '}
                  {(() => {
                    const selected = trial.candidates.find((candidate) => candidate.id === selection)!;
                    const strategy = compositionStrategyInfo(selected.strategy);
                    return `条件${strategy.condition}「${strategy.label}」`;
                  })()}
                </p>
                <div className="blind-totals" aria-label={`累計${votes.length}試行`}>
                  <span className="blind-total-label">累計 {votes.length} 試行</span>
                  {COMPOSITION_STRATEGIES.map((strategy) => (
                    <span key={strategy.id}>
                      条件{strategy.condition} {strategy.label}: <b>{voteSummary[strategy.id]}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="blind-empty">
            条件名と並び順は結果を見るまで表示されません。3候補をすべて聴くと投票できます。
          </p>
        )}

        <div className="blind-votes-tools" data-testid="blind-votes-tools">
          <button type="button" onClick={exportVotes} disabled={votes.length === 0} data-testid="blind-votes-export">
            ⬇ 票をエクスポート（{votes.length}）
          </button>
          <button type="button" onClick={() => votesFileRef.current?.click()} data-testid="blind-votes-import">
            ⬆ 票をインポート
          </button>
          <input
            ref={votesFileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void importVotes(event)}
          />
          <small>
            票はこのブラウザにしか保存されません。定期的にエクスポートして保全してください（重複は統合時に除かれます）。
          </small>
        </div>

        <CompositionResearchPanel />
      </section>
    </div>
  );
}
