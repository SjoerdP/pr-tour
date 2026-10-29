package service

import (
	"cmp"

	"example.com/flow/repo"
)

type Orders interface {
	Place(id string) error
}

type OrderService struct {
	store *repo.Store
	name  string
}

// Place stores the order and notifies in the background.
func (s *OrderService) Place(id string) error {
	if err := s.store.InsertOrder(id); err != nil {
		return err
	}
	go s.notify()
	return nil
}

func (s *OrderService) notify() {
	_ = s.name
}

func (s *OrderService) PlaceWrapped(id string) error {
	return s.place(id)
}

func (s *OrderService) place(id string) error {
	return s.store.InsertOrder(id)
}

type AuditOrders struct{}

func (a AuditOrders) Place(id string) error {
	return nil
}

func Max[T cmp.Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}

type Job struct{}

func Run() {
}

func (j *Job) Run() {
}
