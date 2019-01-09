package beacon

import (
	"context"
	"fmt"
	"time"

	"github.com/keep-network/keep-core/pkg/beacon/relay"
	relaychain "github.com/keep-network/keep-core/pkg/beacon/relay/chain"
	"github.com/keep-network/keep-core/pkg/beacon/relay/event"
	"github.com/keep-network/keep-core/pkg/chain"
	"github.com/keep-network/keep-core/pkg/net"
)

type participantState int

const (
	unstaked participantState = iota
	staked
	waitingForGroup
	inIncompleteGroup
	inCompleteGroup
	inInitializingGroup
	inInitializedGroup
	inActivatingGroup
	inActiveGroup
)

// Initialize kicks off the random beacon by initializing internal state,
// ensuring preconditions like staking are met, and then kicking off the
// internal random beacon implementation. Returns an error if this failed,
// otherwise enters a blocked loop.
func Initialize(
	ctx context.Context,
	stakingID string,
	relayChain relaychain.Interface,
	blockCounter chain.BlockCounter,
	stakeMonitor chain.StakeMonitor,
	netProvider net.Provider,
) error {
	chainConfig, err := relayChain.GetConfig()
	if err != nil {
		return err
	}

	curParticipantState, err := checkParticipantState()
	if err != nil {
		panic(fmt.Sprintf("Could not resolve current relay state, aborting: [%s]", err))
	}

	staker, err := stakeMonitor.StakerFor(stakingID)
	if err != nil {
		return err
	}

	node := relay.NewNode(
		staker,
		netProvider,
		blockCounter,
		chainConfig,
	)

	switch curParticipantState {
	case unstaked:
		// check for stake command-line parameter to initialize staking?
		return fmt.Errorf("account is unstaked")
	default:
		// Retry until we can sync our staking list
		syncStakingListWithRetry(&node, relayChain)

		relayChain.OnRelayEntryRequested(func(request *event.Request) {
			node.GenerateRelayEntryIfEligible(request, relayChain)
		})

		relayChain.OnRelayEntryGenerated(func(entry *event.Entry) {
			node.JoinGroupIfEligible(relayChain, entry.Value)
		})

		relayChain.OnGroupRegistered(func(registration *event.GroupRegistration) {
			node.RegisterGroup(
				registration.RequestID.String(),
				registration.GroupPublicKey,
			)
		})

	}

	<-ctx.Done()

	return nil
}

func checkParticipantState() (participantState, error) {
	return staked, nil
}

func syncStakingListWithRetry(node *relay.Node, relayChain relaychain.Interface) {
	for {
		t := time.NewTimer(1)
		defer t.Stop()

		select {
		case <-t.C:
			_, err := relayChain.GetStakerList()
			if err != nil {
				fmt.Printf(
					"failed to sync staking list: [%v], retrying...\n",
					err,
				)

				// FIXME: exponential backoff
				t.Reset(3 * time.Second)
				continue
			}

			// exit this loop when we've successfully synced
			return
		}
	}
}
