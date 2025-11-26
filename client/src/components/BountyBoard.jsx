import React, { useState, useEffect } from 'react';

function BountyBoard({ onSelect }) {
  const [bounties, setBounties] = useState([]);
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';


  useEffect(() => {
    async function fetchBounties() {
      try {
        const response = await fetch(`${API_URL}/api/bounties`);
        const data = await response.json();
        setBounties(data);
      } catch (error) {
        console.error('Failed to fetch bounties:', error);
      }
    }
    fetchBounties();
  }, []);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {bounties.map((bounty) => (
        <div
          key={bounty.id}
          className="bg-slate-800 p-6 rounded-lg shadow-lg cursor-pointer hover:bg-slate-700 transition"
          onClick={() => onSelect(bounty.topic)}
        >
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold text-emerald-500">{bounty.topic}</h2>
            <span
              className={`px-3 py-1 rounded-full text-sm ${
                bounty.category === 'Medical' ? 'bg-blue-500' : 'bg-purple-500'
              }`}
            >
              {bounty.category}
            </span>
          </div>
          <p className="text-slate-400">Reward: {bounty.reward}</p>
        </div>
      ))}
    </div>
  );
}

export default BountyBoard;
