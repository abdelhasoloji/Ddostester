import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { applyTheme, getTheme } from './theme.js';

// Apply the saved theme before the first paint to avoid a flash.
applyTheme(getTheme());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
