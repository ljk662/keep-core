const fs = require('fs');
const toml = require('toml');
const tomlify = require('tomlify-j0.4');
const concat = require('concat-stream');
const Web3 = require('web3');

// ETH host info
const ethHost = process.env.ETH_HOSTNAME;
const ethWsPort = process.env.ETH_WS_PORT;
const ethRpcPort = process.env.ETH_RPC_PORT;
const ethNetworkId = process.env.ETH_NETWORK_ID;

/*
We override transactionConfirmationBlocks and transactionBlockTimeout because they're
25 and 50 blocks respectively at default.  The result of this on small private testnets
is long wait times for scripts to execute.
*/
const web3_options = {
    defaultBlock: 'latest',
    defaultGas: 4712388,
    transactionBlockTimeout: 25,
    transactionConfirmationBlocks: 3,
    transactionPollingTimeout: 480
};
const web3 = new Web3(new Web3.providers.HttpProvider(ethHost + ':' + ethRpcPort), null, web3_options);


/*
Each <contract.json> file is sourced directly from the InitContainer.  Files are generated by
Truffle during contract and copied to the InitContainer image via Circle.
*/

// TokenStaking
const tokenStakingContractJsonFile = '/tmp/TokenStaking.json';
const tokenStakingContractParsed = JSON.parse(fs.readFileSync(tokenStakingContractJsonFile));
const tokenStakingContractAbi = tokenStakingContractParsed.abi;
const tokenStakingContractAddress = tokenStakingContractParsed.networks[ethNetworkId].address;
const tokenStakingContract = new web3.eth.Contract(tokenStakingContractAbi, tokenStakingContractAddress);

// KeepToken
const keepTokenContractJsonFile = '/tmp/KeepToken.json';
const keepTokenContractParsed = JSON.parse(fs.readFileSync(keepTokenContractJsonFile));
const keepTokenContractAbi = keepTokenContractParsed.abi;
const keepTokenContractAddress = keepTokenContractParsed.networks[ethNetworkId].address;
const keepTokenContract = new web3.eth.Contract(keepTokenContractAbi, keepTokenContractAddress);

// keepRandomBeaconService, only contract address for config file create
const keepRandomBeaconServiceJsonFile = '/tmp/KeepRandomBeaconService.json';
const keepRandomBeaconServiceParsed = JSON.parse(fs.readFileSync(keepRandomBeaconServiceJsonFile));
const keepRandomBeaconServiceContractAddress = keepRandomBeaconServiceParsed.networks[ethNetworkId].address;

// KeepRandomBeaconOperator, only contract address for config file create
const keepRandomBeaconOperatorJsonFile = '/tmp/KeepRandomBeaconOperator.json';
const keepRandomBeaconOperatorParsed = JSON.parse(fs.readFileSync(keepRandomBeaconOperatorJsonFile));
const keepRandomBeaconOperatorContractAddress = keepRandomBeaconOperatorParsed.networks[ethNetworkId].address;

// Stake a target eth account
async function provisionKeepClient() {

  try {
    // Eth account that contracts are migrated against.
    let contractOwner = process.env.CONTRACT_OWNER_ETH_ACCOUNT_ADDRESS;
    // Eth account that's both miner and coinbase on internal testnet
    let purse = process.env.CONTRACT_OWNER_ETH_ACCOUNT_ADDRESS;

    console.log('\n<<<<<<<<<<<< Unlocking Contract Owner Account ' + contractOwner + ' >>>>>>>>>>>>');
    //Transactions during staking are sent from contractOwner, must be unlocked before start.
    await unlockEthAccount(contractOwner, process.env.KEEP_CLIENT_ETH_ACCOUNT_PASSWORD);

    /*
    Funding here will skip this step for bootstrap peers who are already staked.  This is fine
    because the bootstrap peer account is pre-created, unchanging, and funded with
    999997556920000000000 ether as of this comment.  When the bootstrap peer account moves to
    an InitContainer generated account it will always be funded by this step as the isStaked
    and exit conditional step for bootstrap peers will be removed along with the transition
    of the bootstrap peer to InitContainer generated accounts.
    */
    console.log('\n<<<<<<<<<<<< Funding Operator Account ' + operator + ' >>>>>>>>>>>>');
    await fundOperatorAccount(operator, purse, '10');

    console.log('\n<<<<<<<<<<<< Staking Operator Account ' + operator + ' >>>>>>>>>>>>');
    await stakeOperatorAccount(operator, contractOwner);

    console.log('\n<<<<<<<<<<<< Creating keep-client Config File >>>>>>>>>>>>');
    await createKeepClientConfig(operator);

    console.log('\n########### keep-client Provisioning Complete! ###########');
  }
  catch(error) {
    console.error(error.message);
    throw error;
  }
};

async function isStaked(operator) {

  console.log('Checking if operator account is already staked:');
  let stakedAmount = await tokenStakingContract.methods.balanceOf(operator).call();
  return stakedAmount != 0;
}

async function isFunded(operator) {

  console.log('Checking if operator account has ether:')
  let fundedAmount = await web3.fromWei(eth.getBalance(operator), 'ether')
  return isFunded !< 1;
}

async function stakeOperatorAccount(operator, contractOwner) {

  let magpie = contractOwner;
  let authorizer = contractOwner;
  let staked = await isStaked(operator);

  /*
  We need to stake only in cases where an operator account is not already staked.  If the account
  is staked, or the client type is relay-requester we need to exit staking, albeit for different
  reasons.  In the case where the account is already staked, additional staking will fail.
  Clients of type relay-requester don't need to be staked to submit a request, they're acting more
  as a consumer of the network, rather than an operator.
  */
  if (process.env.KEEP_CLIENT_TYPE === 'relay-requester') {
    console.log('Subtype relay-requester set. No staking needed, exiting staking!');
    return;
  } else if (staked === true) {
    console.log('Staked operator account set, exiting staking!');
    return;
  } else {
    console.log('Unstaked operator account set, staking account!');
  }

  let delegation = '0x' + Buffer.concat([
    Buffer.from(magpie.substr(2), 'hex'),
    Buffer.from(operator.substr(2), 'hex'),
    Buffer.from(authorizer.substr(2), 'hex')
  ]).toString('hex');

  console.log('Staking 2000000 KEEP tokens on operator account ' + operator);

  await keepTokenContract.methods.approveAndCall(
    tokenStakingContract.address,
    formatAmount(20000000, 18),
    delegation).send({from: contractOwner})

  await tokenStakingContract.authorizeOperatorContract(
    operatorAddress,
    keepRandomBeaconOperatorContractAddress,
    {from: authorizer});

  console.log('Account ' + operator + ' staked!');
};

async function fundOperatorAccount(operator, purse, etherToTransfer) {

  let funded = await isFunded(operator);
  let transferAmount = web3.utils.toWei(etherToTransfer, 'ether');

  if (funded === true) {
    console.log('Operator account is funded already!');
    return;
  } else {
    console.log('Funding account ' + operator + ' with ' + transferAmount + ' wei from purse ' + purse);
    await web3.eth.sendTransaction({from:purse, to:operator, value:transferAmount});
    console.log('Account ' + operator + ' funded!');
  }
};

async function createKeepClientConfig(operator) {

  fs.createReadStream('/tmp/keep-client-config-template.toml', 'utf8').pipe(concat(function(data) {

    let parsedConfigFile = toml.parse(data);

    parsedConfigFile.ethereum.URL = ethHost.replace('http://', 'ws://') + ':' + ethWsPort;
    parsedConfigFile.ethereum.URLRPC = ethHost + ':' + ethRpcPort;
    parsedConfigFile.ethereum.account.Address = operator;
    parsedConfigFile.ethereum.account.KeyFile = process.env.KEEP_CLIENT_ETH_KEYFILE;
    parsedConfigFile.ethereum.ContractAddresses.KeepRandomBeaconOperator = keepRandomBeaconOperatorContractAddress;
    parsedConfigFile.ethereum.ContractAddresses.KeepRandomBeaconService = keepRandomBeaconServiceContractAddress;
    parsedConfigFile.ethereum.ContractAddresses.TokenStaking = tokenStakingContractAddress;
    parsedConfigFile.LibP2P.Port = 3919;
    parsedConfigFile.Storage.DataDir = process.env.KEEP_DATA_DIR;

    /*
    tomlify.toToml() writes our Seed/Port values as a float.  The added precision renders our config
    file unreadable by the keep-client as it interprets 3919.0 as a string when it expects an int.
    Here we format the default rendering to write the config file with Seed/Port values as needed.
    */
    let formattedConfigFile = tomlify.toToml(parsedConfigFile, {
      replace: (key, value) => { return (key == 'Port') ? value.toFixed(0) : false }
    });

    fs.writeFile('/mnt/keep-client/config/keep-client-config.toml', formattedConfigFile, (error) => {
      if (error) throw error;
    });
  }));
  console.log('keep-client config written to /mnt/keep-client/config/keep-client-config.toml');
};

/*
\heimdall aliens numbers.  Really though, the approveAndCall function expects numbers
in a particular format, this function facilitates that.
*/
function formatAmount(amount, decimals) {
  return '0x' + web3.utils.toBN(amount).mul(web3.utils.toBN(10).pow(web3.utils.toBN(decimals))).toString('hex');
};

provisionKeepClient().catch(error => {
  console.error(error);
  process.exit(1);
});

