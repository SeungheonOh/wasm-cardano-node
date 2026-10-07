import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import App from './chain.jsx';
hydrateRoot(document.getElementById('root'), <App initialHosted={document.documentElement.dataset.hosted === 'true'}/>);
