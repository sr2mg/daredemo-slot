import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BgmStudio } from './bgm-studio.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BgmStudio />
  </StrictMode>,
);
