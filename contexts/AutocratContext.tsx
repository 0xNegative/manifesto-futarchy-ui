import React, { ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useLocalStorage } from '@mantine/hooks';
import { useQueries, useQuery } from '@tanstack/react-query';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { useProvider } from '@/hooks/useProvider';
import {
  AUTOCRAT_VERSIONS,
  staticTokens,
  devnetTokens,
  mainnetTokens,
  DAOS,
} from '@/lib/constants';
import {
  AutocratProgram,
  DaoState,
  ProgramVersion,
  Proposal,
  TokensDict,
  Token,
} from '../lib/types';
import { Networks, useNetworkConfiguration } from '../hooks/useNetworkConfiguration';
import { getTokenMetadata } from '@/utils/token';
import { AMM_PROGRAM_ID } from '@/sdk/src/constants';
import { AmmClient, SwapType } from '@/sdk/src/AmmClient';

export interface AutocratContext {
  daoKey?: PublicKey;
  daoTreasuryKey?: PublicKey;
  daoState?: DaoState;
  daoTokens?: TokensDict;
  proposals?: Proposal[];
  autocratProgram?: Program<AutocratProgram>;
  ammClient?: AmmClient;
  programVersion?: ProgramVersion;
  setProgramVersion: (e: number) => void;
  createAmm: (
    pof: string,
    uri: string,
    proposalNumber: number,
    symbol: string,
    a: number,
  ) => Promise<void>;
  swap: (swapType: SwapType, inputAmount: number, outputAmountMin: number) => Promise<void>;
}

export const contextAutocrat = createContext<AutocratContext>({
  setProgramVersion: () => {},
  createAmm: async () => {},
  swap: async () => {},
});

export const useAutocrat = () => {
  const context = useContext<AutocratContext>(contextAutocrat);
  return context;
};

export function AutocratProvider({ children }: { children: ReactNode }) {
  const { network } = useNetworkConfiguration();
  const provider = useProvider();
  const [programVersion, setProgramVersion] = useLocalStorage<ProgramVersion>({
    key: 'program_version',
    defaultValue: AUTOCRAT_VERSIONS[0],
    serialize: (value) => String(AUTOCRAT_VERSIONS.indexOf(value)),
    deserialize: (value) => AUTOCRAT_VERSIONS[Number(value)],
  });

  const { programId, idl } = programVersion!;

  const autocratProgram = useMemo(
    () => new Program<AutocratProgram>(idl as AutocratProgram, programId, provider),
    [programId.toString(), !!provider, network],
  );

  const ammClient = useMemo(
    () =>
      AmmClient.createClient({
        provider: provider as AnchorProvider,
        ammProgramId: AMM_PROGRAM_ID,
      }),
    [provider, network],
  );

  // TODO: We need to surface an option to select a DAO, so there's
  // some point of reference from the user to allow us to sort on this.
  // I've setup a list of DAOs hard coded, but this is still missing a
  // selection given you may have many starting at v0.3
  const daosQueryKey = `${network}-${programVersion.label}-${programVersion.dao}-daolist`;
  const { data: daos } = useQuery({
    queryKey: [daosQueryKey],
    queryFn: () => autocratProgram.account.dao.all(),
    staleTime: 30_000,
    refetchOnMount: false,
  });

  // TODO: THIS NEEDS TO BE HANDLED WHEN MULTI DAO
  // Filter against our list of DAOs
  let selectedDao = daos?.find((dao) => dao.publicKey.toString() === DAOS[0].publicKey.toString());

  // Need to use any DAO even if we didn't get a match from our list
  if (!selectedDao && daos) {
    [selectedDao] = daos;
  }

  const daoKey = selectedDao?.publicKey;

  const daoTreasuryKey = selectedDao?.account.treasury;

  const daoState = selectedDao?.account;

  const [proposals, setProposals] = useState<Proposal[]>();

  const proposalsQueryKey = `${network}-${programVersion.label}-${programVersion.dao}-proposals`;
  const { data: allProposals } = useQuery({
    queryKey: [proposalsQueryKey],
    queryFn: () => autocratProgram?.account.proposal?.all(),
    staleTime: 30_000,
    refetchOnMount: false,
  });

  // Moved token stuff into the Autocrat, given this is where we reference core tokens
  const defaultTokens: TokensDict = useMemo(() => {
    switch (network) {
      case Networks.Devnet:
        return { ...staticTokens, ...devnetTokens };
      case Networks.Mainnet:
        return { ...staticTokens, ...mainnetTokens };
      case Networks.Custom:
        return { ...staticTokens, ...mainnetTokens, ...devnetTokens };
      default:
        // TODO: Dunno, got stuck on this.
        return { ...staticTokens, ...mainnetTokens, ...devnetTokens };
    }
  }, [network, programVersion.label]);

  const [daoTokens, setDaoTokens] = useLocalStorage<TokensDict>({
    key: 'futarchy-tokens',
    defaultValue: defaultTokens,
    getInitialValueInEffect: true,
    serialize: JSON.stringify,
    deserialize: (s) => {
      if (!s) return {};
      const o: TokensDict = JSON.parse(s);
      return Object.fromEntries(
        Object.entries(o).map(([k, v]: [string, Token]) => [
          k,
          { ...v, publicKey: new PublicKey(v.publicKey) },
        ]),
      );
    },
  });

  useQueries({
    queries: [
      {
        queryKey: ['daoBase', provider.connection.rpcEndpoint],
        queryFn: async () => {
          if (daoTokens && daoTokens.baseToken) {
            return getTokenMetadata(
              provider.connection,
              daoTokens.baseToken.publicKey,
              undefined,
              TOKEN_PROGRAM_ID,
            );
          }
        },
        enabled: !!daoTokens.baseToken,
        refetchOnMount: true,
      },
      {
        queryKey: ['daoQuote', provider.connection.rpcEndpoint],
        queryFn: async () => {
          if (daoTokens && daoTokens.quoteToken) {
            return getTokenMetadata(
              provider.connection,
              daoTokens.quoteToken.publicKey,
              undefined,
              TOKEN_PROGRAM_ID,
            );
          }
        },
        enabled: !!daoTokens.quoteToken,
        refetchOnMount: true,
      },
    ],
  });

  // We need to wait for the DAO state to be updated and fetched to pull from it
  // and build our actually used tokens.
  useEffect(() => {
    if (daoState) {
      const daoTokenPublicKey = daoState?.tokenMint!;

      // This fetches and compares across the token list we maintain
      const daoToken = Object.entries(defaultTokens).filter(
        (token) => token[1].publicKey.toString() === daoTokenPublicKey.toString(),
      );

      // Our "base" token which historically was called META, and in other version TOKEN
      const baseToken = { baseToken: daoToken[0][1] };

      // Our "quote" token, so far this is and is only planned to be USDC
      let quoteToken = { quoteToken: defaultTokens.usdc };

      // Needed as we want to start using real USDC on devnet from here on out
      if (programVersion?.label !== 'V0.3' && network === 'devnet') {
        quoteToken = { quoteToken: defaultTokens.musdc };
      }

      // Combine our tokens we want to use vs defaults
      const usedTokens: TokensDict = { ...staticTokens, ...baseToken, ...quoteToken };

      // Simple optimization to prevent unnecessary updates
      const mergedTokens = { ...daoTokens, ...usedTokens };

      if (JSON.stringify(mergedTokens) !== JSON.stringify(usedTokens)) {
        setDaoTokens(mergedTokens);
      }
    }
    // NOTE: Stub this "selectedDao" for use in a future version.
  }, [selectedDao, programVersion.label, network, daoState, defaultTokens]);

  useEffect(() => {
    const props = (allProposals || []).sort((a, b) =>
      a.account.number < b.account.number ? 1 : -1,
    );

    const _proposals: Proposal[] = props.map((prop) => ({
      title: `Proposal ${prop.account.number}`,
      description: '',
      ...prop,
    }));
    setProposals(_proposals);
  }, [allProposals, programVersion.label, network]);

  const createAmm = async (
    pof: string,
    uri: string,
    proposalNumber: number,
    symbol: string,
    a: number,
  ) => {
    if (
      !autocratProgram ||
      !daoState ||
      !daoTokens?.baseToken ||
      !daoTokens?.quoteToken ||
      !provider.wallet
    ) {
      return;
    }

    // Check that the base and quote mints are different
    if (daoTokens.baseToken.publicKey.equals(daoTokens.quoteToken.publicKey)) {
      throw new Error('Base and quote mints must be different');
    }

    // Check that the base mint has a supply of 0
    const baseMint = await autocratProgram.account.mint.fetch(daoTokens.baseToken.publicKey);
    if (baseMint.supply !== 0) {
      throw new Error('Base mint must have a supply of 0');
    }

    try {
      const [proposalAddress] = await PublicKey.findProgramAddress(
        [Buffer.from('proposal'), Buffer.from(proposalNumber.toString())],
        autocratProgram.programId,
      );
      await ammClient.createAmm(
        proposalAddress,
        daoTokens.baseToken.publicKey,
        daoTokens.quoteToken.publicKey,
        daoState.twapInitialObservation,
        pof,
        uri,
        proposalNumber,
        daoTokens.baseToken.publicKey,
        daoTokens.quoteToken.publicKey,
        a,
        daoState.twapMaxObservationChangePerUpdate,
      );
    } catch (err) {
      console.error('Error creating AMM:', err);
      throw err;
    }
  };

  const swap = async (swapType: SwapType, inputAmount: number, outputAmountMin: number) => {
    if (
      !autocratProgram ||
      !daoState ||
      !daoTokens?.baseToken ||
      !daoTokens?.quoteToken ||
      !provider.wallet
    ) {
      return;
    }

    const [ammPublicKey] = await PublicKey.findProgramAddress(
      [
        Buffer.from('amm__'),
        daoTokens.baseToken.publicKey.toBuffer(),
        daoTokens.quoteToken.publicKey.toBuffer(),
      ],
      AMM_PROGRAM_ID,
    );

    const amm = await ammClient.getAmm(ammPublicKey);

    try {
      await ammClient.swap(amm.publicKey, swapType, inputAmount, outputAmountMin);
    } catch (err) {
      console.error('Error swapping tokens:', err);
      throw err;
    }
  };

  return (
    <contextAutocrat.Provider
      value={{
        daoKey,
        daoTreasuryKey,
        daoState,
        daoTokens,
        proposals,
        autocratProgram,
        ammClient,
        programVersion,
        setProgramVersion: (n) =>
          setProgramVersion(
            n < AUTOCRAT_VERSIONS.length ? AUTOCRAT_VERSIONS[n] : AUTOCRAT_VERSIONS[0],
          ),
        createAmm,
        swap,
      }}
    >
      {children}
    </contextAutocrat.Provider>
  );
}
