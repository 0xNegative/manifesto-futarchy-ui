import { useCallback } from 'react';
import { Keypair, Transaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useAutocrat } from '@/contexts/AutocratContext';

export function useInitializeProposal() {
  const { connection } = useConnection();
  const { autocratProgram: program, daoKey, daoTreasuryKey, daoTokens } = useAutocrat();
  const wallet = useWallet();

  const baseToken = daoTokens?.baseToken;
  const quoteToken = daoTokens?.quoteToken;

  const initializeProposal = useCallback(
    async (url: string, instruction: ProposalInstruction) => {
      if (
        !wallet?.publicKey ||
        !wallet.signAllTransactions ||
        !baseToken ||
        !quoteToken ||
        !daoTreasuryKey ||
        !program
      ) {
        return;
      }

      const proposalKeypair = Keypair.generate();
      const initProposalTx = new Transaction().add(
        await program.account.proposal.createInstruction(proposalKeypair, 1500),
        await program.methods
          .initializeProposal({
            descriptionUrl: url,
            instruction,
            passLpTokensToLock: 0, // @TODO 0xNegative
            failLpTokensToLock: 0, // @TODO 0xNegative
            nonce: 0, // @TODO 0xNegative
          })
          .accounts({
            proposal: proposalKeypair.publicKey,
            dao: daoKey,
            failAmm,
            passAmm,
            proposer: wallet.publicKey,
          })
          .instruction(),
      );

      const latestBlockhash = await connection.getLatestBlockhash();
      initProposalTx.feePayer = wallet.publicKey!;
      initProposalTx.recentBlockhash = latestBlockhash.blockhash;
      initProposalTx.sign(proposalKeypair);

      const signedTxs = await wallet.signAllTransactions([initProposalTx]);

      await Promise.all(
        signedTxs.map(async (tx) => {
          const signature = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
          });
          return connection.confirmTransaction(
            {
              signature,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            'confirmed',
          );
        }),
      );
    },
    [daoKey, program, connection, wallet, baseToken, quoteToken, daoTreasuryKey],
  );

  return {
    initializeProposal,
  };
}
