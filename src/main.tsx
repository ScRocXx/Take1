import './lib/device'; // marks phones first, so their styles apply from the first paint
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './ui/tokens.css';
import './ui/app.css';

createRoot(document.getElementById('root')!).render(<App />);
