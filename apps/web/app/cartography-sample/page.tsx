'use client';

import dynamic from 'next/dynamic';

const Sample = dynamic(() => import('../../src/map-design/components/CartographySampleMap'), { ssr: false });
export default function Page() { return <Sample />; }
