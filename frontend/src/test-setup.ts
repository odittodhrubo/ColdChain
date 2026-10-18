import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup); // vitest runs without globals, so Testing Library cannot register this itself

// findBy* waits 1 s by default: too tight when every suite (backend, ML, firmware) runs at once on one machine
configure({ asyncUtilTimeout: 4000 });
