import { createRoot } from 'react-dom/client';
import { loadSettings } from '../lib/storage';
import { App } from './App';
import './console.css';

void loadSettings().then((s) => {
  createRoot(document.getElementById('root')!).render(<App initial={s} />);
});
