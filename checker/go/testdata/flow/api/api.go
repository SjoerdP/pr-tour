package api

import (
	"strings"

	"example.com/flow/service"
)

type Router struct{}

func (r *Router) Handle(path string, fn any) {}

type Handler struct {
	orders service.Orders
}

func (h *Handler) Create(id string) error {
	id = strings.TrimSpace(id)
	return h.orders.Place(id)
}

func Routes(r *Router, h *Handler) {
	r.Handle("/orders", h.Create)
	r.Handle("/ping", func() { h.ping() })
}

func (h *Handler) ping() {
}
