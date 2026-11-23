import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 共通スタイルを先に読み、ワークスペース固有のスタイル(composer/workspace.css)が後から重なるようにする。
import './styles.css';
import { BgmStudio } from './bgm-studio.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BgmStudio />
  </StrictMode>,
);
