/** MIDIノート番号 → 周波数(Hz)。A4=69=440Hzの平均律。全バックエンド共通。 */
export const midiFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
