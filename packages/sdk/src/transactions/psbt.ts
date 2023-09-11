import * as ecc from "@bitcoinerlab/secp256k1"
import { BIP32Factory } from "bip32"
import { Psbt } from "bitcoinjs-lib"

import { OrditApi } from "../api"
import { Network } from "../config/types"
import { MINIMUM_AMOUNT_IN_SATS } from "../constants"
import FeeEstimator from "../fee/FeeEstimator"
import { createTransaction, getNetwork, toXOnly } from "../utils"
import { OnOffUnion } from "../wallet"
import { UTXO, UTXOLimited } from "./types"

const bip32 = BIP32Factory(ecc)

export async function createPsbt({
  pubKey,
  network,
  address,
  outputs,
  satsPerByte,
  safeMode = "on",
  enableRBF = true
}: CreatePsbtOptions) {
  if (!outputs.length) {
    throw new Error("Invalid request")
  }

  const { spendableUTXOs, unspendableUTXOs, totalUTXOs } = await OrditApi.fetchUnspentUTXOs({
    address,
    network,
    type: safeMode === "off" ? "all" : "spendable"
  })

  if (!totalUTXOs) {
    throw new Error("No spendable UTXOs")
  }

  const nativeNetwork = getNetwork(network)
  const psbt = new Psbt({ network: nativeNetwork })
  const inputSats = spendableUTXOs
    .concat(safeMode === "off" ? unspendableUTXOs : [])
    .reduce((acc, utxo) => (acc += utxo.sats), 0)
  const outputSats = outputs.reduce((acc, utxo) => (acc += utxo.cardinals), 0)

  // add inputs
  const witnesses: Buffer[] = []
  for (const [index, utxo] of spendableUTXOs.entries()) {
    if (utxo.scriptPubKey.address !== address) continue

    const payload = await processInput({ utxo, pubKey, network })
    payload.type === "taproot" && payload.witnesses && witnesses.push(...payload.witnesses)
    psbt.addInput(payload)

    if (enableRBF) {
      psbt.setInputSequence(index, 0xfffffffd)
    }
  }

  const feeEstimator = new FeeEstimator({
    psbt,
    feeRate: satsPerByte,
    network
  })
  const fee = feeEstimator.calculateNetworkFee()

  const remainingBalance = inputSats - outputSats - fee
  if (remainingBalance < 0) {
    throw new Error(`Insufficient balance. Available: ${inputSats}. Attemping to spend: ${outputSats}. Fees: ${fee}`)
  }

  const isChangeOwed = remainingBalance > MINIMUM_AMOUNT_IN_SATS
  if (isChangeOwed) {
    outputs.push({
      address,
      cardinals: remainingBalance
    })
  }

  // add outputs
  outputs.forEach((out) => {
    psbt.addOutput({
      address: out.address,
      value: out.cardinals
    })
  })

  return {
    hex: psbt.toHex(),
    base64: psbt.toBase64()
  }
}

export async function processInput({
  utxo,
  pubKey,
  network,
  sighashType,
  witnesses
}: ProcessInputOptions): Promise<InputType> {
  switch (utxo.scriptPubKey.type) {
    case "witness_v1_taproot":
      return generateTaprootInput({ utxo, pubKey, network, sighashType, witnesses })

    case "witness_v0_scripthash":
    case "witness_v0_keyhash":
      return generateSegwitInput({ utxo, sighashType })

    case "scripthash":
      return generateNestedSegwitInput({ utxo, pubKey, network, sighashType })

    case "pubkeyhash":
      return generateLegacyInput({ utxo, sighashType, network })

    default:
      throw new Error("invalid script pub type")
  }
}

function generateTaprootInput({
  utxo,
  pubKey,
  network,
  sighashType,
  witnesses
}: ProcessInputOptions): TaprootInputType {
  const chainCode = Buffer.alloc(32)
  chainCode.fill(1)

  const key = bip32.fromPublicKey(Buffer.from(pubKey, "hex"), chainCode, getNetwork(network))
  const xOnlyPubKey = toXOnly(key.publicKey)

  if (!utxo.scriptPubKey.hex) {
    throw new Error("Unable to process p2tr input")
  }

  return {
    type: "taproot",
    hash: utxo.txid,
    index: utxo.n,
    tapInternalKey: xOnlyPubKey,
    witnessUtxo: {
      script: Buffer.from(utxo.scriptPubKey.hex, "hex"),
      value: utxo.sats
    },
    witnesses,
    ...(sighashType ? { sighashType } : undefined)
  }
}

function generateSegwitInput({ utxo, sighashType }: Omit<ProcessInputOptions, "pubKey" | "network">): SegwitInputType {
  if (!utxo.scriptPubKey.hex) {
    throw new Error("Unable to process Segwit input")
  }

  return {
    type: "segwit",
    hash: utxo.txid,
    index: utxo.n,
    witnessUtxo: {
      script: Buffer.from(utxo.scriptPubKey.hex, "hex"),
      value: utxo.sats
    },
    ...(sighashType ? { sighashType } : undefined)
  }
}

function generateNestedSegwitInput({ utxo, pubKey, network, sighashType }: ProcessInputOptions): NestedSegwitInputType {
  const p2sh = createTransaction(Buffer.from(pubKey, "hex"), "p2sh", network)
  if (!p2sh || !p2sh.output || !p2sh.redeem) {
    throw new Error("Unable to process Segwit input")
  }

  return {
    type: "nested-segwit",
    hash: utxo.txid,
    index: utxo.n,
    redeemScript: p2sh.redeem.output!,
    witnessUtxo: {
      script: Buffer.from(utxo.scriptPubKey.hex, "hex"),
      value: utxo.sats
    },
    ...(sighashType ? { sighashType } : undefined)
  }
}

async function generateLegacyInput({
  utxo,
  sighashType,
  network
}: Omit<ProcessInputOptions, "pubKey">): Promise<LegacyInputType> {
  const { rawTx } = await OrditApi.fetchTx({ txId: utxo.txid, network, hex: true })
  if (!rawTx) {
    throw new Error("Unable to process legacy input")
  }

  return {
    type: "legacy",
    hash: utxo.txid,
    index: utxo.n,
    nonWitnessUtxo: rawTx?.toBuffer(),
    ...(sighashType ? { sighashType } : undefined)
  }
}

// TODO: replace below interfaces and custom types w/ PsbtInputExtended from bitcoinjs-lib
interface BaseInputType {
  hash: string
  index: number
  sighashType?: number
}

type LegacyInputType = BaseInputType & {
  type: "legacy"
  nonWitnessUtxo?: Buffer
}

type SegwitInputType = BaseInputType & {
  type: "segwit"
  witnessUtxo?: {
    script: Buffer
    value: number
  }
  witnesses?: Buffer[]
}

type TaprootInputType = BaseInputType &
  Omit<SegwitInputType, "type"> & {
    type: "taproot"
    tapInternalKey: Buffer
  }

type NestedSegwitInputType = BaseInputType &
  Omit<SegwitInputType, "type"> & {
    type: "nested-segwit"
    redeemScript: Buffer
  }

export type InputType = LegacyInputType | SegwitInputType | NestedSegwitInputType | TaprootInputType

export type CreatePsbtOptions = {
  satsPerByte: number
  address: string
  outputs: {
    address: string
    cardinals: number
  }[]
  enableRBF?: boolean
  pubKey: string
  network: Network
  safeMode?: OnOffUnion
}

interface ProcessInputOptions {
  utxo: UTXO | UTXOLimited
  pubKey: string
  network: Network
  sighashType?: number
  witnesses?: Buffer[]
}
