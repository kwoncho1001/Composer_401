import { parseCodeToNodes } from './src/services/astParser.js';
import * as fs from 'fs';

const code = `
import React, { useState, useEffect } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  const [text, setText] = useState('');

  useEffect(() => {
    console.log(count);
  }, [count]);

  const handleClick = () => {
    setCount(c => c + 1);
  };

  return (
    <div onClick={handleClick}>
      {count}
    </div>
  );
}
`;

const result = parseCodeToNodes('App.tsx', code);
console.log('Total units extracted:', result.length);
result.forEach((u, i) => {
  console.log(`\n--- Unit ${i + 1}: ${u.title} (Lines ${u.startLine}-${u.endLine}) ---`);
  console.log(u.code);
});
