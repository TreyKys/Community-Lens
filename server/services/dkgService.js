import DkgClient from 'dkg.js';
import crypto from 'crypto';

function getDkgClient() {
  if (!process.env.PRIVATE_KEY) {
    console.warn('PRIVATE_KEY is not set. DKG minting will be simulated.');
    return null;
  }
  return new DkgClient({
    endpoint: 'https://dkg-testnet.origintrail.io',
    privateKey: process.env.PRIVATE_KEY,
  });
}

function createSimulatedUAL(data) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return `did:dkg:otp:2043/0x${hash}`;
}

export async function mintCommunityNote(data) {
  const dkg = getDkgClient();
  if (!dkg) {
    return { ual: createSimulatedUAL(data), simulated: true };
  }

  try {
    const asset = await dkg.asset.create({
      data,
      metadata: {
        type: 'CommunityNote',
        topic: data.topic,
      },
    });
    return { ual: asset.ual };
  } catch (error) {
    console.warn('DKG minting failed, creating simulated UAL:', error.message);
    return { ual: createSimulatedUAL(data), simulated: true };
  }
}
